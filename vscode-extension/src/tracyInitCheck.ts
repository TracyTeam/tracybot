import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';
import { getRepoPath } from './utils';
import { clearFailureCooldown, notifyFailureOnce } from './failureCooldown';
import { clearInitDeclined, getInitState, recordInitDeclined } from './initState';

// A failed init (e.g. no Python) gets a cooldown, not a permanent skip — same
// rationale as hookAgentPluginCheck.ts: a since-fixed problem (Python
// installed later) should get picked up again, not stay silenced forever.
const INIT_FAILURE_COOLDOWN_KEY = 'tracybot.tracyInitFailureAt';

async function findPython(): Promise<string> {
  for (const cmd of ['python3', 'python']) {
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(cmd, ['--version'], { stdio: 'ignore' });
        proc.on('close', code => (code === 0 ? resolve() : reject()));
        proc.on('error', reject);
      });
      return cmd;
    } catch {
      // try next
    }
  }
  throw new Error('Python is not installed or not available.');
}

// Asks before setting up a repo rather than doing it on open: init adds Git
// hooks and records AI prompts in the repo's history, which not every
// project opened in VS Code should get. A repo that is already set up but
// points at a script from an older extension version is repaired without
// asking, since its user already said yes. Returns whether the repo is
// initialized afterwards.
export async function checkTracyInit(context: vscode.ExtensionContext): Promise<boolean> {
  const repoPath = await getRepoPath();
  if (!repoPath) { return false; }

  switch (getInitState(repoPath)) {
    case 'initialized':
      await clearFailureCooldown(context.globalState, INIT_FAILURE_COOLDOWN_KEY);
      return true;
    case 'needs-repair':
      return runInit(context, repoPath, false);
    case 'declined':
      return false;
    case 'undecided': {
      const action = await vscode.window.showInformationMessage(
        'Do you want to initialize Tracybot for this project?',
        'Initialize',
        'Not now',
        'Never for this project'
      );
      if (action === 'Initialize') {
        return runInit(context, repoPath, true);
      }
      if (action === 'Never for this project') {
        recordInitDeclined(repoPath);
      }
      // 'Not now' or dismissed: writes nothing, so this repo is asked again
      // next time it's opened.
      return false;
    }
  }
}

// Backs the Initialize command and the Initialize buttons elsewhere: runs
// even if this repo was declined before, since the user is now asking for it.
export async function initializeRepo(context: vscode.ExtensionContext): Promise<boolean> {
  const repoPath = await getRepoPath();
  if (!repoPath) {
    vscode.window.showInformationMessage('Tracybot: open a folder inside a git repository first.');
    return false;
  }
  if (getInitState(repoPath) === 'initialized') {
    vscode.window.showInformationMessage('Tracybot is already initialized in this repository.');
    return true;
  }

  clearInitDeclined(repoPath);
  return runInit(context, repoPath, true);
}

// A failure the user just asked for is always shown; an automatic repair's
// failure goes through the cooldown so it isn't reshown on every activation.
async function runInit(context: vscode.ExtensionContext, repoPath: string, userRequested: boolean): Promise<boolean> {
  const reportFailure = async (err: unknown) => {
    const show = () => {
      vscode.window.showErrorMessage(
        `Failed to initialize Tracybot in this repository: ${err instanceof Error ? err.message : String(err)}`
      );
    };
    if (userRequested) {
      show();
    } else {
      await notifyFailureOnce(context.globalState, INIT_FAILURE_COOLDOWN_KEY, show);
    }
  };

  let python: string;
  try {
    python = await findPython();
  } catch (err) {
    await reportFailure(err);
    return false;
  }

  const initPy = path.join(context.extensionUri.fsPath, 'assets', 'init.py');

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(python, [initPy, repoPath], { stdio: 'inherit' });
      proc.on('close', code =>
        code === 0 ? resolve() : reject(new Error(`init.py exited with code ${code}`))
      );
      proc.on('error', reject);
    });

    await clearFailureCooldown(context.globalState, INIT_FAILURE_COOLDOWN_KEY);
    vscode.window.showInformationMessage('Tracybot: repository initialized.');
    return true;
  } catch (error) {
    await reportFailure(error);
    return false;
  }
}
