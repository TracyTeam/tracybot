/// <reference types="mocha" />
import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Research Mode integration', () => {
  test('extension activates without throwing', async () => {
    const ext = vscode.extensions.getExtension('TracyTeam.tracybot-extension');
    assert.ok(ext, 'extension not found');
    await ext!.activate();
    assert.ok(ext!.isActive);
  });

  test('reviewResearchDigest command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('tracybot-extension.reviewResearchDigest'),
      'tracybot-extension.reviewResearchDigest not registered'
    );
  });

  test('reviewResearchDigest command does not throw when invoked', async () => {
    // showInformationMessage blocks on user interaction that never comes in a
    // headless test run, so it never resolves here — that's expected. What we
    // want to catch is any synchronous error thrown before reaching that call
    // (e.g. reading an undefined property while building the digest message).
    let rejected: unknown;
    const commandPromise = vscode.commands
      .executeCommand('tracybot-extension.reviewResearchDigest')
      .then(() => undefined, (err) => { rejected = err; });

    await Promise.race([commandPromise, new Promise(resolve => setTimeout(resolve, 500))]);
    assert.strictEqual(rejected, undefined, `command rejected: ${String(rejected)}`);
  });

  test('reviewResearchDigest palette title is "Tracybot: Manage Research Mode"', () => {
    const ext = vscode.extensions.getExtension('TracyTeam.tracybot-extension');
    assert.ok(ext, 'extension not found');
    const commands: { command: string; title: string }[] = ext!.packageJSON.contributes.commands;
    const entry = commands.find(c => c.command === 'tracybot-extension.reviewResearchDigest');
    assert.ok(entry, 'reviewResearchDigest command not found in package.json');
    assert.strictEqual(entry!.title, 'Tracybot: Manage Research Mode');
  });
});
