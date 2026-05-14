import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { getRepoPath } from './utils';

const SKIP_INIT_KEY = 'tracybot.skipTracyInit';

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

export async function checkTracyInit(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(SKIP_INIT_KEY)) { return; }

  const repoPath = await getRepoPath();
  if (!repoPath) { return; }

  const tracyConfig = path.join(repoPath, '.git', 'tracybot', 'config');
  if (fs.existsSync(tracyConfig)) { return; }

  const action = await vscode.window.showInformationMessage(
    'Tracy is not initialized in this repository. Would you like to initialize it now?',
    'Initialize',
    'Ignore',
    'Never Show Again'
  );

  if (action === 'Never Show Again') {
    await context.globalState.update(SKIP_INIT_KEY, true);
    return;
  }

  if (action !== 'Initialize') { return; }

  let python: string;
  try {
    python = await findPython();
  } catch (err) {
    vscode.window.showErrorMessage(
      `Failed to initialize Tracy: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  const initPy = path.join(context.extensionUri.fsPath, 'init.py');

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(python, [initPy, repoPath], { stdio: 'inherit' });
      proc.on('close', code =>
        code === 0 ? resolve() : reject(new Error(`init.py exited with code ${code}`))
      );
      proc.on('error', reject);
    });

    vscode.window.showInformationMessage('Tracy initialized successfully.');
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to initialize Tracy: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
