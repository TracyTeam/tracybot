import * as vscode from 'vscode';
import { getOrCreateParticipantId, isResearchModeEnabled } from './consent';

const SKIP_PROMPT_KEY = 'tracybot.skipResearchModePrompt';

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
    await vscode.workspace.getConfiguration('tracybot.researchMode')
      .update('enabled', true, vscode.ConfigurationTarget.Global);
    getOrCreateParticipantId(context);

    const followUpAction = await vscode.window.showInformationMessage(
      "Research Mode enabled at Tier 1 (stats only — no prompt text or code shared). " +
      "Want to share more? Raise the 'Consent Tier' setting anytime.",
      'Adjust Sharing Level'
    );

    if (followUpAction === 'Adjust Sharing Level') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'tracybot.researchMode.consentTier');
    }
  } else if (action === 'Never Show Again') {
    await context.globalState.update(SKIP_PROMPT_KEY, true);
  }
  // 'Not now' or dismissed: do nothing — stays unchecked, asked again next activation
}
