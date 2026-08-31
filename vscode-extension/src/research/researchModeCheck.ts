import * as vscode from 'vscode';
import { getRepoPath } from '../utils';
import { getOrCreateParticipantId } from './consent';
import { readRepoConsent, writeRepoConsent } from './repoConsent';

interface TierPickItem extends vscode.QuickPickItem {
  tier: 1 | 2;
}

// Shown inline as part of opting in, not buried in Settings afterward — a
// setting nobody finds might as well not exist, but the choice still has to
// be an actual choice (see each item's detail), not a pre-picked default.
const TIER_OPTIONS: TierPickItem[] = [
  {
    tier: 1,
    label: 'Prompt and response text',
    description: 'fenced code blocks redacted',
    detail: 'Shares what you asked the AI and what it replied.',
  },
  {
    tier: 2,
    label: '+ Code diffs',
    description: 'only the lines each AI edit touched',
    detail: 'Also shares the actual code each AI-generated Tasklet changed.',
  },
];

// Exported (rather than exporting TIER_OPTIONS directly) so the Manage
// Research Mode command in extension.ts can offer the exact same tier
// picker for a Change Tier action, without duplicating how it's presented.
export async function pickResearchModeTier(): Promise<1 | 2 | undefined> {
  const chosen = await vscode.window.showQuickPick(TIER_OPTIONS, {
    title: 'Tracybot Research Mode — choose how much to share',
    placeHolder: 'You can change or disable this anytime from the Research Mode status bar item',
    ignoreFocusOut: true,
  });
  return chosen?.tier;
}

// Shared by the initial opt-in prompt and by re-enabling a previously
// declined repo (see extension.ts's Manage Research Mode command) — both
// are "turn Research Mode on and pick a tier," differing only in what
// prompted it.
export async function enableResearchModeForRepo(context: vscode.ExtensionContext, repoPath: string): Promise<void> {
  // Dismissed (Escape) without picking — fall back to the most conservative
  // tier rather than leaving some other prior value in place.
  const tier = (await pickResearchModeTier()) ?? 1;

  writeRepoConsent(repoPath, { decision: 'enabled', consentTier: tier });
  getOrCreateParticipantId(context);

  vscode.window.showInformationMessage(
    `Research Mode enabled at Tier ${tier} for this repository. Change or disable it anytime from the Research Mode status bar item.`
  );
}

// Per-repository, not machine-wide (see repoConsent.ts) — agreeing to share
// one project's Tasklet history shouldn't silently enroll every other repo
// opened afterward. Each repo gets asked once: "declined" and "enabled" are
// both terminal decisions for that repo; only a genuinely undecided repo
// (no consent file yet) prompts again.
export async function checkResearchModeConsent(context: vscode.ExtensionContext): Promise<void> {
  const repoPath = await getRepoPath();
  if (!repoPath) { return; }
  if (readRepoConsent(repoPath)) { return; }

  const action = await vscode.window.showInformationMessage(
    'Help improve Tracybot: share this repository\'s Tasklet history for a study on AI-assisted coding behavior?',
    'I agree to share my data',
    'Not now',
    'Never for this repo'
  );

  if (action === 'I agree to share my data') {
    await enableResearchModeForRepo(context, repoPath);
  } else if (action === 'Never for this repo') {
    writeRepoConsent(repoPath, { decision: 'declined' });
  }
  // 'Not now' or dismissed: writes nothing — this repo stays undecided,
  // asked again next time it's opened/activated.
}
