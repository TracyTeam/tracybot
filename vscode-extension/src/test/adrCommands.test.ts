/// <reference types="mocha" />
import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createAdrFromTasklet } from '../adrCommands';
import { History } from '../history/types';

suite('ADR drafts integration', () => {
  test('the refresh command is registered once the extension has activated', async () => {
    const ext = vscode.extensions.getExtension('TracyTeam.tracybot-extension');
    assert.ok(ext, 'extension not found');
    await ext!.activate();

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('tracybot-extension.refreshAdrStatus'), 'refreshAdrStatus not registered');
  });

  test('the refresh command has a palette title', () => {
    const ext = vscode.extensions.getExtension('TracyTeam.tracybot-extension');
    assert.ok(ext, 'extension not found');
    const commands: { command: string; title: string }[] = ext!.packageJSON.contributes.commands;
    const entry = commands.find(c => c.command === 'tracybot-extension.refreshAdrStatus');
    assert.ok(entry, 'refreshAdrStatus not found in package.json');
    assert.strictEqual(entry!.title, 'Tracybot: Refresh ADR Status');
  });

  test('the ADR folder setting defaults to docs/adr', () => {
    assert.strictEqual(vscode.workspace.getConfiguration('tracybot').get<string>('adrDirectory'), 'docs/adr');
  });

  // A minimal History with one committed tasklet that still owns a line.
  const history: History = {
    id: 'head',
    files: [{
      path: 'a.ts',
      tasklets: [{
        id: 'snap-1', model: 'anthropic/claude-sonnet-5', name: 'Add caching', taskletId: 't1', sessionId: 's1',
        messages: [{ stage: 'build', type: 'prompt', message: 'Add caching' }, { stage: 'build', type: 'response', message: 'Done.' }],
        lines: [1, 2], ghostLines: [], originCommitHash: 'abc1234', agentSource: 'opencode',
      }],
    }],
  };

  const tmpDirs: string[] = [];
  const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tracybot-adr-host-'))); tmpDirs.push(d); return d; };
  teardown(() => { for (const d of tmpDirs.splice(0)) { fs.rmSync(d, { recursive: true, force: true }); } });

  // The title prompt blocks on a user in a headless run, so answer it with its default.
  async function withTitlePromptAnswered<T>(run: () => Promise<T>): Promise<T> {
    const win = vscode.window as any;
    const original = win.showInputBox;
    win.showInputBox = async (options: vscode.InputBoxOptions) => options.value;
    try { return await run(); } finally { win.showInputBox = original; }
  }

  test('Create ADR writes into the repository it is given, not one the workspace would pick', async () => {
    // No workspace folder is open here, so getRepoPath() has nothing to offer: the
    // repository can only come from the argument, as it does for a panel's button.
    const repoA = tmp();
    const repoB = tmp();

    await withTitlePromptAnswered(() => createAdrFromTasklet(history, repoB, 'snap-1'));

    const written = fs.readdirSync(path.join(repoB, 'docs', 'adr'));
    assert.deepStrictEqual(written, ['0001-add-caching.md']);
    assert.ok(fs.readFileSync(path.join(repoB, 'docs', 'adr', written[0]), 'utf8').startsWith('---\nstatus: accepted\n'));
    assert.deepStrictEqual(fs.readdirSync(repoA), [], 'nothing is written to the other repository');
  });

  test('Create ADR refuses an ADR folder that is a symlink out of the repository', async function () {
    const repo = tmp();
    const outside = tmp();
    try {
      fs.symlinkSync(outside, path.join(repo, 'docs'));
    } catch {
      this.skip();
    }

    await withTitlePromptAnswered(() => createAdrFromTasklet(history, repo, 'snap-1'));

    assert.deepStrictEqual(fs.readdirSync(outside), [], 'nothing is written through the link');
  });
});
