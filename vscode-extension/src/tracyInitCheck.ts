import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { getRepoPath } from './utils';

// A failed init (e.g. no Python) gets a cooldown, not a permanent skip — same
// rationale as hookAgentPluginCheck.ts: a since-fixed problem (Python
// installed later) should get picked up again, not stay silenced forever.
const INIT_FAILURE_COOLDOWN_KEY = 'tracybot.tracyInitFailureAt';
const FAILURE_RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

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

// No confirmation prompt — same rationale as hookAgentPluginCheck.ts:
// installing Tracybot is itself the user's opt-in to AI change tracing, so
// auto-initializing a detected repository is redundant friction, not extra
// consent. Still surfaces a non-blocking notification once it's done, and an
// error notification if it fails — neither requires a click to proceed.
export async function checkTracyInit(context: vscode.ExtensionContext): Promise<void> {
  const lastFailureAt = context.globalState.get<number>(INIT_FAILURE_COOLDOWN_KEY);
  if (lastFailureAt && Date.now() - lastFailureAt < FAILURE_RETRY_COOLDOWN_MS) { return; }

  const repoPath = await getRepoPath();
  if (!repoPath) { return; }

  const tracyConfig = path.join(repoPath, '.git', 'tracybot', 'config');
  if (fs.existsSync(tracyConfig)) { return; }

  let python: string;
  try {
    python = await findPython();
  } catch (err) {
    await context.globalState.update(INIT_FAILURE_COOLDOWN_KEY, Date.now());
    vscode.window.showErrorMessage(
      `Failed to initialize Tracybot in this repository: ${err instanceof Error ? err.message : String(err)}`
    );
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

    vscode.window.showInformationMessage('Tracybot: repository initialized.');
  } catch (error) {
    await context.globalState.update(INIT_FAILURE_COOLDOWN_KEY, Date.now());
    vscode.window.showErrorMessage(
      `Failed to initialize Tracybot in this repository: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
