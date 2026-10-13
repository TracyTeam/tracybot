/// <reference types="mocha" />
import * as assert from 'assert';
import * as vscode from 'vscode';

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
});
