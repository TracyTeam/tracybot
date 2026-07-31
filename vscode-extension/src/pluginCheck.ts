import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import { detectAnyHookAgent } from './hookAgentPluginCheck';

const PLUGIN_FILENAME = 'tracybot-oc.js';
const PLUGIN_URL = 'https://github.com/TracyTeam/tracybot/releases/latest/download/tracybot-oc.js';
const SKIP_CHECK_KEY = 'tracybot.skipPluginCheck';
const SKIP_OPENCODE_MISSING_KEY = 'tracybot.skipOpencodeMissingCheck';

function getGlobalPluginPath(): string {
  return path.join(homedir(), '.config', 'opencode', 'plugin', PLUGIN_FILENAME);
}

function getProjectPluginPath(): string | undefined {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { return undefined; }

  return path.join(workspaceRoot, '.opencode', 'plugin', PLUGIN_FILENAME);
}

async function installPluginTo(dir: string): Promise<void> {
  const destPath = path.join(dir, PLUGIN_FILENAME);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  const response = await fetch(PLUGIN_URL);
  if (!response.ok) { throw new Error(`Plugin download failed: (${response.status})`); }

  fs.writeFileSync(destPath, Buffer.from(await response.arrayBuffer()));
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
  if (context.globalState.get<boolean>(SKIP_CHECK_KEY)) { return; }

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

  if (fs.existsSync(getGlobalPluginPath())) { return; }

  const projectPath = getProjectPluginPath();
  if (projectPath && fs.existsSync(projectPath)) { return; }

  // No confirmation prompt — same rationale as checkHookBasedAgents: installing
  // Tracybot already signals consent to trace AI changes, so this just installs
  // globally (matching the other two agents' user-level install location) and
  // tells the user afterward, without blocking on a click.
  const installPath = getGlobalPluginPath();

  try {
    await installPluginTo(path.dirname(installPath));
    vscode.window.showInformationMessage(`Tracybot: OpenCode plugin installed to ${installPath}.`);
  } catch (error) {
    await context.globalState.update(SKIP_CHECK_KEY, true);
    vscode.window.showErrorMessage(
      `Failed to install Tracybot OpenCode plugin: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
