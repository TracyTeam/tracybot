/// <reference types="mocha" />
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { buildHistory } from '../history/buildHistory';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tracybot-build-history-'));
}

function initRepoWithCommit(dir: string): void {
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email test@example.com', { cwd: dir });
  execSync('git config user.name Test', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  execSync('git add a.txt && git commit -q -m init', { cwd: dir });
}

suite('buildHistory failure reasons', () => {
  test('a non-git folder is reported as not-a-git-repo', async () => {
    const dir = makeTempDir();
    const result = await buildHistory(dir);
    assert.strictEqual(result.ok, false);
    if (!result.ok) { assert.strictEqual(result.reason, 'not-a-git-repo'); }
  });

  test('an initialized repo with zero commits is reported as no-commits', async () => {
    const dir = makeTempDir();
    execSync('git init -q', { cwd: dir });
    const result = await buildHistory(dir);
    assert.strictEqual(result.ok, false);
    if (!result.ok) { assert.strictEqual(result.reason, 'no-commits'); }
  });

  test('a normal repo with a commit builds successfully', async () => {
    const dir = makeTempDir();
    initRepoWithCommit(dir);
    const result = await buildHistory(dir);
    assert.strictEqual(result.ok, true);
  });

  test('no repoPath is reported as no-repo-path', async () => {
    const result = await buildHistory(undefined);
    assert.strictEqual(result.ok, false);
    if (!result.ok) { assert.strictEqual(result.reason, 'no-repo-path'); }
  });
});
