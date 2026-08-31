import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { ParticipantContext } from './types';
import { getConsentTierForRepo, isResearchModeEnabledForRepo } from './repoConsent';
import { getRemoteUrl } from './gitRemote';

const PARTICIPANT_ID_KEY = 'tracybot.researchMode.participantId';

// Enabled/tier are per-repository (see repoConsent.ts) — re-exported here so
// callers only need one import for "am I collecting, and how much".
export const isResearchModeEnabled = isResearchModeEnabledForRepo;
export const getConsentTier = getConsentTierForRepo;

// Generated locally on opt-in, stored per-machine (not per-workspace) since a
// participant is a single person, not a single repo — and never derived from
// git identity (user.name/user.email), by design.
export function getOrCreateParticipantId(context: vscode.ExtensionContext): string {
  const existing = context.globalState.get<string>(PARTICIPANT_ID_KEY);
  if (existing) {
    return existing;
  }

  const generated = randomUUID();
  context.globalState.update(PARTICIPANT_ID_KEY, generated);
  return generated;
}

export async function getParticipantContext(context: vscode.ExtensionContext, repoPath: string): Promise<ParticipantContext> {
  return {
    participantId: getOrCreateParticipantId(context),
    repoUrl: await getRemoteUrl(repoPath),
  };
}
