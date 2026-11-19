/// <reference types="mocha" />
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { buildHistory } from '../history/buildHistory';
import { buildAdr } from '../adr/buildAdr';
import { refreshAdrStatus } from '../adr/refresh';
import { History } from '../history/types';

// Same fake-agent commit the other buildHistory tests use: a hidden snapshot
// commit in the tracy chain carrying the turn's JSON.
function commitAiEdit(dir: string, parentHash: string, taskletId: string, prompt: string, ts: number): string {
  const tree = execSync('git write-tree', { cwd: dir, encoding: 'utf8' }).trim();
  const body = JSON.stringify({
    id: taskletId, sessionId: 'sess1', source: 'claude-code', model: 'anthropic/claude-sonnet-5',
    prompt, response: `Did: ${prompt}`, promptCreatedAt: ts, responseCompletedAt: ts,
  });
  return execSync(`git commit-tree ${tree} -p ${parentHash}`, {
    cwd: dir, input: `${taskletId}\n\n${body}`, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'claude-code', GIT_AUTHOR_EMAIL: 'claude-code', GIT_COMMITTER_NAME: 'claude-code', GIT_COMMITTER_EMAIL: 'claude-code' },
  }).trim();
}

const SRC = (call: string) => ['def process(order):', `    total = ${call}(order)`, '    return None', ''].join('\n');
const NOW = new Date('2026-10-13T10:00:00.000Z');

suite('ADR status computed from a real History', () => {
  let dir: string;
  let history: History;

  suiteSetup(async function () {
    this.timeout(60000);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracybot-adr-'));
    const sh = (cmd: string) => execSync(cmd, { cwd: dir, encoding: 'utf8' }).trim();
    sh('git init -q'); sh('git config user.email t@e.com'); sh('git config user.name T');

    const file = path.join(dir, 'app.py');
    fs.writeFileSync(file, ['def process(order):', '    # placeholder', '    return None', ''].join('\n'));
    sh('git add app.py && git commit -q -m init');
    const base = sh('git rev-parse HEAD');

    // Three consecutive prompts re-edit the same line.
    fs.writeFileSync(file, SRC('calculate_shipping_cost')); sh('git add app.py');
    const c1 = commitAiEdit(dir, base, 'tasklet-1', 'add shipping cost calculation', 1000);
    fs.writeFileSync(file, SRC('compute_shipping_cost')); sh('git add app.py');
    const c2 = commitAiEdit(dir, c1, 'tasklet-2', 'rename calculate to compute', 2000);
    fs.writeFileSync(file, SRC('compute_cost')); sh('git add app.py');
    const c3 = commitAiEdit(dir, c2, 'tasklet-3', 'remove shipping from the function name', 3000);

    sh(`git update-ref refs/tracy-local/aaaa1111 ${c3}`);
    sh('git config tracy.current-id aaaa1111');

    const result = await buildHistory(dir);
    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }
    history = result.history;
  });

  suiteTeardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('an earlier prompt whose line was re-edited is superseded by the prompt that owns it now', () => {
    const adr = buildAdr(history, 'tasklet-1', { title: 'Add shipping cost', now: NOW })!;

    assert.strictEqual(adr.status.status, 'superseded');
    assert.deepStrictEqual(adr.status.supersededBy.map(s => s.key), ['tasklet-3']);
    assert.match(adr.markdown, /^---\nstatus: superseded\n/);
    assert.ok(adr.markdown.includes('add shipping cost calculation'), 'the original request is quoted');
  });

  test('the prompt that owns the line today is proposed while the work is uncommitted', () => {
    const adr = buildAdr(history, 'tasklet-3', { title: 'Drop shipping from the name', now: NOW })!;

    assert.strictEqual(adr.status.status, 'proposed');
    assert.match(adr.markdown, /^---\nstatus: proposed\n/);
  });

  test('refreshing the ADR of the latest prompt after the user commits flips it to accepted', async function () {
    this.timeout(60000);
    const md = buildAdr(history, 'tasklet-3', { title: 'Drop shipping from the name', now: NOW })!.markdown;

    const sh = (cmd: string) => execSync(cmd, { cwd: dir, encoding: 'utf8' }).trim();
    sh('git add -A && git commit -q -am "shipping cost (AI assisted)"');
    sh('git notes add -m "tracy-id: aaaa1111" HEAD');
    sh(`git update-ref refs/tracy/aaaa1111 ${sh('git rev-parse refs/tracy-local/aaaa1111')}`);
    sh('git config --unset tracy.current-id');

    const after = await buildHistory(dir);
    assert.strictEqual(after.ok, true);
    if (!after.ok) { return; }

    const refreshed = refreshAdrStatus(md, after.history, new Date('2026-12-01T00:00:00.000Z'));
    assert.strictEqual(refreshed.kind, 'ok');
    if (refreshed.kind !== 'ok') { return; }
    assert.strictEqual(refreshed.status, 'accepted');
    assert.match(refreshed.markdown, /^---\nstatus: accepted\n/);
  });
});
