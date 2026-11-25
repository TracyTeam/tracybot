import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import { detectAnyHookAgent } from './hookAgentPluginCheck';
import { clearFailureCooldown, notifyFailureOnce } from './failureCooldown';
import { isSyncedFor, syncPluginFile } from './opencodePluginSync';

const PLUGIN_FILENAME = 'tracybot-oc.js';
const SKIP_OPENCODE_MISSING_KEY = 'tracybot.skipOpencodeMissingCheck';

// Same rationale as hookAgentPluginCheck.ts: a failed install gets a cooldown,
// not a permanent skip, so a transient failure can't permanently defeat the
// daily re-check in extension.ts.
const INSTALL_FAILURE_COOLDOWN_KEY = 'tracybot.opencodeInstallFailureAt';

function getGlobalPluginPath(): string {
  return path.join(homedir(), '.config', 'opencode', 'plugin', PLUGIN_FILENAME);
}

function getProjectPluginPath(): string | undefined {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { return undefined; }

  return path.join(workspaceRoot, '.opencode', 'plugin', PLUGIN_FILENAME);
}

async function findOpencode(): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('opencode', ['--version'], { stdio: 'ignore' });
      proc.on('close', code => (code === 0 ? resolve() : reject()));
      proc.on('error', reject);
    });
    return true;
  } catch {
    return false;
  }
}

export async function checkOpencode(context: vscode.ExtensionContext): Promise<void> {
  const opencodeAvailable = await findOpencode();
  if (!opencodeAvailable) {
    // Claude Code or Codex being installed is enough — this message (and its
    // "requires a supported agent" wording) is only accurate when none of
    // the three are present. Those two get their own install prompts from
    // checkHookBasedAgents; this function only owns OpenCode's.
    if (await detectAnyHookAgent()) { return; }

    if (context.globalState.get<boolean>(SKIP_OPENCODE_MISSING_KEY)) { return; }

    const action = await vscode.window.showInformationMessage(
      'Tracybot AI change tracing requires a supported agent.',
      'View Supported Agents',
      'Don\'t Show Again'
    );

    if (action === 'View Supported Agents') {
      vscode.env.openExternal(vscode.Uri.parse('https://github.com/TracyTeam/tracybot#supported-agents-and-editors'));
    } else if (action === 'Don\'t Show Again') {
      await context.globalState.update(SKIP_OPENCODE_MISSING_KEY, true);
    }
    return;
  }

  const globalPath = getGlobalPluginPath();
  const extensionVersion: string = context.extension.packageJSON.version;

  if (isSyncedFor(globalPath, extensionVersion, context.globalState)) {
    await clearFailureCooldown(context.globalState, INSTALL_FAILURE_COOLDOWN_KEY);
    return;
  }

  // A project-local plugin may be committed to the user's repo, so it's left
  // alone and, as before, stands in for a global install. A global plugin
  // that already exists is still kept up to date below.
  const projectPath = getProjectPluginPath();
  if (!fs.existsSync(globalPath) && projectPath && fs.existsSync(projectPath)) {
    await clearFailureCooldown(context.globalState, INSTALL_FAILURE_COOLDOWN_KEY);
    return;
  }

  // No confirmation prompt — same rationale as checkHookBasedAgents: installing
  // Tracybot already signals consent to trace AI changes, so this just installs
  // globally (matching the other two agents' user-level install location) and
  // tells the user afterward, without blocking on a click.
  try {
    const result = await syncPluginFile(globalPath, extensionVersion, context.globalState, fetch);
    await clearFailureCooldown(context.globalState, INSTALL_FAILURE_COOLDOWN_KEY);
    if (result === 'installed') {
      vscode.window.showInformationMessage(`Tracybot: OpenCode plugin installed to ${globalPath}.`);
    } else if (result === 'updated') {
      vscode.window.showInformationMessage('Tracybot: OpenCode plugin updated. Restart OpenCode to use it.');
    }
  } catch (error) {
    await notifyFailureOnce(context.globalState, INSTALL_FAILURE_COOLDOWN_KEY, () => {
      vscode.window.showErrorMessage(
        `Failed to install Tracybot OpenCode plugin: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }
}
