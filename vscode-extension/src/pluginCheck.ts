import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

const PLUGIN_FILENAME = 'tracybot-oc.js';
const PLUGIN_URL = 'https://github.com/TracyTeam/tracybot/releases/latest/download/tracybot-oc.js';
const SKIP_CHECK_KEY = 'tracybot.skipPluginCheck';

const Actions = {
  InstallGlobally: 'Install Globally',
  InstallForProject: 'Install for Project',
  Ignore: 'Ignore',
  NeverShowAgain: 'Never Show Again',
} as const;

type Action = (typeof Actions)[keyof typeof Actions];

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

export async function checkOpencode(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(SKIP_CHECK_KEY)) { return; }
  if (fs.existsSync(getGlobalPluginPath())) { return; }

  const projectPath = getProjectPluginPath();
  if (projectPath && fs.existsSync(projectPath)) { return; }

  const buttons: Action[] = [Actions.InstallGlobally];
  if (projectPath) { buttons.push(Actions.InstallForProject); }
  buttons.push(Actions.Ignore, Actions.NeverShowAgain);

  const action = await vscode.window.showInformationMessage(
    'Tracybot OpenCode plugin is not installed. Would you like to install now?',
    ...buttons
  );

  if (action === Actions.NeverShowAgain) {
    await context.globalState.update(SKIP_CHECK_KEY, true);
    return;
  }

  // skip and catch-all for sanity
  if (action !== Actions.InstallGlobally && action !== Actions.InstallForProject) { return; }

  try {
    let installPath;
    if (action === Actions.InstallGlobally) {
      installPath = getGlobalPluginPath();
    } else {
      if (!projectPath) { throw new Error("Not in a workspace."); }

      installPath = projectPath;
    }

    await installPluginTo(path.dirname(installPath));
    vscode.window.showInformationMessage(`Tracybot OpenCode plugin installed to ${installPath}.`);
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to install plugin: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
