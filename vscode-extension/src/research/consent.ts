import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { ParticipantContext } from './types';

const PARTICIPANT_ID_KEY = 'tracybot.researchMode.participantId';

function getConfig() {
  return vscode.workspace.getConfiguration('tracybot.researchMode');
}

export function isResearchModeEnabled(): boolean {
  return getConfig().get<boolean>('enabled', false);
}

export function getConsentTier(): 1 | 2 | 3 {
  const tier = getConfig().get<number>('consentTier', 1);
  return tier === 2 || tier === 3 ? tier : 1;
}

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

export function getParticipantContext(context: vscode.ExtensionContext): ParticipantContext {
  const config = getConfig();
  const repoUrl = config.get<string>('repoUrl', '').trim();

  return {
    participantId: getOrCreateParticipantId(context),
    repoUrl: repoUrl.length > 0 ? repoUrl : null,
  };
}
