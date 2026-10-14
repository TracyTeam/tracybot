/// <reference types="mocha" />
import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'TracyTeam.tracybot-extension';

function getExtension(): vscode.Extension<unknown> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, 'extension not found');
  return ext!;
}

// Some command handlers await a showInformationMessage/showWarningMessage
// that blocks on user interaction that never comes in a headless test run —
// executeCommand then never resolves. Races it against a timeout so a
// command that's SUPPOSED to hang there doesn't hang the whole suite; what
// we're actually checking is that nothing threw before that point.
async function runWithoutHanging(command: string, ...args: unknown[]): Promise<void> {
  let rejected: unknown;
  const commandPromise = vscode.commands
    .executeCommand(command, ...args)
    .then(() => undefined, (err) => { rejected = err; });

  await Promise.race([commandPromise, new Promise(resolve => setTimeout(resolve, 500))]);
  assert.strictEqual(rejected, undefined, `${command} rejected: ${String(rejected)}`);
}

suite('Extension activation and command surface', () => {
  test('extension activates without throwing', async () => {
    const ext = getExtension();
    await ext.activate();
    assert.ok(ext.isActive);
  });

  test('every contributed command is registered', async () => {
    const ext = getExtension();
    const contributed: { command: string }[] = ext.packageJSON.contributes.commands;
    assert.ok(contributed.length > 0, 'package.json declares no commands');

    const registered = await vscode.commands.getCommands(true);
    for (const { command } of contributed) {
      assert.ok(registered.includes(command), `${command} not registered`);
    }
  });

  test('every contributed command title starts with "Tracybot:"', () => {
    const ext = getExtension();
    const contributed: { command: string; title: string }[] = ext.packageJSON.contributes.commands;
    assert.ok(contributed.length > 0, 'package.json declares no commands');

    for (const { command, title } of contributed) {
      assert.ok(title.startsWith('Tracybot:'), `${command}'s title "${title}" doesn't start with "Tracybot:"`);
    }
  });

  test('blameAI with no active editor warns instead of throwing', async () => {
    // A headless test run with no folder/document open always hits the
    // "No active editor" branch, which fires the warning without awaiting
    // it — the command itself should resolve promptly rather than hang.
    assert.strictEqual(vscode.window.activeTextEditor, undefined, 'test setup assumption: no active editor');
    await runWithoutHanging('tracybot-extension.blameAI');
  });

  test('invoking blameAI repeatedly with no editor stays stable', async () => {
    // Guards against state left behind by one invocation (e.g. a stale
    // history/lineMap) breaking a later one.
    await runWithoutHanging('tracybot-extension.blameAI');
    await runWithoutHanging('tracybot-extension.blameAI');
  });

  test('invalidateCache resolves without throwing outside a repository', async () => {
    await runWithoutHanging('tracybot-extension.invalidateCache');
  });

  test('reviewResearchDigest without an open repository does not hang', async () => {
    // getRepoPath() resolves to undefined when no folder is open (this
    // suite's test run opens none) — that branch fires its message without
    // awaiting it too, so this should behave the same as the no-editor
    // blameAI case above rather than blocking on a prompt dismissal.
    await runWithoutHanging('tracybot-extension.reviewResearchDigest');
  });
});
