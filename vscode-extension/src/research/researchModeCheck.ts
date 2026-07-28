import * as vscode from 'vscode';
import { getOrCreateParticipantId, isResearchModeEnabled } from './consent';

const SKIP_PROMPT_KEY = 'tracybot.skipResearchModePrompt';

interface TierPickItem extends vscode.QuickPickItem {
  tier: 1 | 2 | 3;
}

// Shown inline as part of opting in, not buried in Settings afterward — a
// setting nobody finds might as well not exist, but the choice still has to
// be an actual choice (see each item's detail), not a pre-picked default.
const TIER_OPTIONS: TierPickItem[] = [
  {
    tier: 1,
    label: 'Stats only',
    description: 'model, timestamps, line counts',
    detail: 'No prompt text, no code is shared.',
  },
  {
    tier: 2,
    label: '+ Prompt and response text',
    description: 'fenced code blocks redacted',
    detail: 'Also shares what you asked the AI and what it replied.',
  },
  {
    tier: 3,
    label: '+ Code diffs',
    description: 'only the lines each AI edit touched',
    detail: 'Also shares the actual code each AI-generated Tasklet changed.',
  },
];

export async function checkResearchModeConsent(context: vscode.ExtensionContext): Promise<void> {
  if (isResearchModeEnabled()) { return; }
  if (context.globalState.get<boolean>(SKIP_PROMPT_KEY)) { return; }

  const action = await vscode.window.showInformationMessage(
    'Help improve Tracybot: share your Tasklet history for a study on AI-assisted coding behavior? ' +
    'You can disable this anytime in Settings.',
    'I agree to share my data',
    'Not now',
    'Never Show Again'
  );

  if (action === 'I agree to share my data') {
    const chosen = await vscode.window.showQuickPick(TIER_OPTIONS, {
      title: 'Tracybot Research Mode — choose how much to share',
      placeHolder: 'You can change this anytime in Settings → Tracybot Research Mode',
      ignoreFocusOut: true,
    });

    // Dismissed (Escape) without picking — fall back to the most
    // conservative tier rather than leaving some other prior value in place.
    const tier = chosen?.tier ?? 1;

    const config = vscode.workspace.getConfiguration('tracybot.researchMode');
    await config.update('enabled', true, vscode.ConfigurationTarget.Global);
    await config.update('consentTier', tier, vscode.ConfigurationTarget.Global);
    getOrCreateParticipantId(context);

    vscode.window.showInformationMessage(
      `Research Mode enabled at Tier ${tier}. Change this anytime in Settings → Tracybot Research Mode.`
    );
  } else if (action === 'Never Show Again') {
    await context.globalState.update(SKIP_PROMPT_KEY, true);
  }
  // 'Not now' or dismissed: do nothing — stays unchecked, asked again next activation
}
