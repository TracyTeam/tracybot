import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { getRepoPath } from './utils';
import { clearFailureCooldown, notifyFailureOnce } from './failureCooldown';

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

// init.py writes TRACY_SNAPSHOT_SCRIPT as an absolute path into *this*
// extension version's own directory (assets/tracking/tracy.py). VS Code
// deletes the previous version's directory on every auto-update, so a repo
// initialized under an older version silently ends up pointing at a script
// that no longer exists. A missing config file's mere *existence* isn't
// enough to call a repo "initialized" — the target it points to has to
// still be there, or every future commit hook run fails to find it.
function isTracySnapshotScriptValid(tracyConfigPath: string): boolean {
  try {
    const content = fs.readFileSync(tracyConfigPath, 'utf8');
    const match = content.match(/^TRACY_SNAPSHOT_SCRIPT=(.+)$/m);
    return !!match && fs.existsSync(match[1].trim());
  } catch {
    return false;
  }
}

// No confirmation prompt — same rationale as hookAgentPluginCheck.ts:
// installing Tracybot is itself the user's opt-in to AI change tracing, so
// auto-initializing a detected repository is redundant friction, not extra
// consent. Still surfaces a non-blocking notification once it's done, and an
// error notification if it fails — neither requires a click to proceed.
export async function checkTracyInit(context: vscode.ExtensionContext): Promise<void> {
  const repoPath = await getRepoPath();
  if (!repoPath) { return; }

  const tracyConfig = path.join(repoPath, '.git', 'tracybot', 'config');
  if (fs.existsSync(tracyConfig) && isTracySnapshotScriptValid(tracyConfig)) {
    await clearFailureCooldown(context.globalState, INIT_FAILURE_COOLDOWN_KEY);
    return;
  }

  let python: string;
  try {
    python = await findPython();
  } catch (err) {
    await notifyFailureOnce(context.globalState, INIT_FAILURE_COOLDOWN_KEY, () => {
      vscode.window.showErrorMessage(
        `Failed to initialize Tracybot in this repository: ${err instanceof Error ? err.message : String(err)}`
      );
    });
    return;
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
  } catch (error) {
    await notifyFailureOnce(context.globalState, INIT_FAILURE_COOLDOWN_KEY, () => {
      vscode.window.showErrorMessage(
        `Failed to initialize Tracybot in this repository: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }
}
