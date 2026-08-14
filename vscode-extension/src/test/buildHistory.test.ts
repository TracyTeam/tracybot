/// <reference types="mocha" />
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { buildHistory, describeBuildHistoryFailure } from '../history/buildHistory';

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

  test('no repoPath has an actionable AI Blame message', () => {
    assert.strictEqual(
      describeBuildHistoryFailure('no-repo-path'),
      'AI Blame: No repository found for the current workspace.'
    );
  });
});

// Builds a real hidden tracy-local commit on top of `parent`, matching the
// exact shape claude-code-plugin/tracy.py produces: subject line is a bare
// tasklet id, body is the JSON turn record, author/committer is the agent.
function commitAiEdit(dir: string, parentHash: string, taskletId: string, sessionId: string, prompt: string, timestamp: number): string {
  const tree = execSync('git write-tree', { cwd: dir, encoding: 'utf8' }).trim();
  const body = JSON.stringify({
    id: taskletId,
    sessionId,
    source: 'claude-code',
    model: 'anthropic/claude-sonnet-5',
    prompt,
    response: `Did: ${prompt}`,
    promptCreatedAt: timestamp,
    responseCompletedAt: timestamp,
  });
  const message = `${taskletId}\n\n${body}`;
  const commit = execSync(`git commit-tree ${tree} -p ${parentHash}`, {
    cwd: dir,
    input: message,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'claude-code', GIT_AUTHOR_EMAIL: 'claude-code', GIT_COMMITTER_NAME: 'claude-code', GIT_COMMITTER_EMAIL: 'claude-code' },
  }).trim();
  return commit;
}

suite('buildHistory significance filtering across a tracy-local chain', () => {
  test('a second, textually-similar AI edit to a previously-untouched line still gets attributed', async () => {
    const dir = makeTempDir();
    execSync('git init -q', { cwd: dir });
    execSync('git config user.email test@example.com', { cwd: dir });
    execSync('git config user.name Test', { cwd: dir });

    const filePath = path.join(dir, 'app.py');
    fs.writeFileSync(filePath, [
      'def calculate_total(items):',
      '    total = 0',
      '    for item in items:',
      '        total += item.price * item.quantity',
      '    if len(items) > 10:',
      '        total *= 0.9',
      '    return total',
      '',
    ].join('\n'));
    execSync('git add app.py && git commit -q -m init', { cwd: dir });
    const baseCommit = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();

    // AI edit 1: add a docstring (an insertion, untouched by edit 2 below)
    fs.writeFileSync(filePath, [
      'def calculate_total(items):',
      '    """Calculate the total price for a list of cart items."""',
      '    total = 0',
      '    for item in items:',
      '        total += item.price * item.quantity',
      '    if len(items) > 10:',
      '        total *= 0.9',
      '    return total',
      '',
    ].join('\n'));
    execSync('git add app.py', { cwd: dir });
    const commit1 = commitAiEdit(dir, baseCommit, 'tasklet-1', 'sess1', 'add a docstring', 1000);

    // AI edit 2: a tiny, textually-similar follow-up to a DIFFERENT,
    // previously-untouched line (> 10 -> >= 10) — realistic "iterate on
    // it" prompt. Before the fix, this got silently dropped: the diff
    // hunk here is nearly identical to what was already there, and the
    // old code applied the same "insignificant -> don't attribute"
    // filter used for User->AI transitions to this AI->AI transition too.
    fs.writeFileSync(filePath, [
      'def calculate_total(items):',
      '    """Calculate the total price for a list of cart items."""',
      '    total = 0',
      '    for item in items:',
      '        total += item.price * item.quantity',
      '    if len(items) >= 10:',
      '        total *= 0.9',
      '    return total',
      '',
    ].join('\n'));
    execSync('git add app.py', { cwd: dir });
    const commit2 = commitAiEdit(dir, commit1, 'tasklet-2', 'sess1', 'actually make it >= not just >', 2000);

    execSync(`git update-ref refs/tracy-local/chain-1 ${commit2}`, { cwd: dir });
    execSync('git config tracy.current-id chain-1', { cwd: dir });
    // Leave the working file as edit 2's content (real, uncommitted AI
    // edits), but reset HEAD/index back to the base commit — matches a
    // real session where nothing has been `git commit`-ed yet.
    execSync(`git reset -q --mixed ${baseCommit}`, { cwd: dir });

    const result = await buildHistory(dir);
    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }

    const file = result.history.files.find(f => f.path === 'app.py');
    assert.ok(file, 'app.py should appear in history');
    const tasklet1 = file!.tasklets.find(t => t.taskletId === 'tasklet-1');
    const tasklet2 = file!.tasklets.find(t => t.taskletId === 'tasklet-2');

    assert.ok(tasklet2, 'the second AI edit must still be attributed, not silently dropped');
    assert.ok(tasklet2!.lines.length > 0, 'the second AI edit must own a live line, not just a ghost one');
    assert.ok(
      !tasklet1 || !tasklet1.lines.some(l => tasklet2!.lines.includes(l)),
      'the two edits touch different lines here, so there should be no overlapping live-line claim'
    );
  });

  test('a tiny first AI edit that nearly reverts to the user\'s original code is still filtered out', async () => {
    const dir = makeTempDir();
    execSync('git init -q', { cwd: dir });
    execSync('git config user.email test@example.com', { cwd: dir });
    execSync('git config user.name Test', { cwd: dir });

    const filePath = path.join(dir, 'app.py');
    fs.writeFileSync(filePath, [
      'def calculate_total(items):',
      '    total = 0',
      '    if len(items) > 10:',
      '        total *= 0.9',
      '    return total',
      '',
    ].join('\n'));
    execSync('git add app.py && git commit -q -m init', { cwd: dir });
    const baseCommit = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();

    // A single, near-identical AI "edit" (> 10 -> >= 10) as the FIRST
    // snapshot in a fresh chain — diffing against the user's own
    // original code. This is the actual User->AI case the significance
    // filter exists for, and must still be suppressed.
    fs.writeFileSync(filePath, [
      'def calculate_total(items):',
      '    total = 0',
      '    if len(items) >= 10:',
      '        total *= 0.9',
      '    return total',
      '',
    ].join('\n'));
    execSync('git add app.py', { cwd: dir });
    const commit1 = commitAiEdit(dir, baseCommit, 'tasklet-idx0', 'sess2', 'tiny tweak', 1000);

    execSync(`git update-ref refs/tracy-local/chain-idx0 ${commit1}`, { cwd: dir });
    execSync('git config tracy.current-id chain-idx0', { cwd: dir });
    execSync(`git reset -q --mixed ${baseCommit}`, { cwd: dir });

    const result = await buildHistory(dir);
    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }

    const file = result.history.files.find(f => f.path === 'app.py');
    const tasklet = file?.tasklets.find(t => t.taskletId === 'tasklet-idx0');
    assert.ok(
      !tasklet || tasklet.lines.length === 0,
      'a tiny User->AI edit must not be credited to AI as a live line'
    );
  });
});

suite('buildHistory does not blanket-credit a whole hunk to one tasklet', () => {
  test('a human commit bundling a tiny AI-line tweak with an unrelated adjacent comment only credits the AI line', async () => {
    const dir = makeTempDir();
    execSync('git init -q', { cwd: dir });
    execSync('git config user.email test@example.com', { cwd: dir });
    execSync('git config user.name Test', { cwd: dir });

    const filePath = path.join(dir, 'app.py');
    fs.writeFileSync(filePath, [
      'def calculate_total(items):',
      '    total = 0',
      '    # end of discount check',
      '    return total',
      '',
    ].join('\n'));
    execSync('git add app.py && git commit -q -m init', { cwd: dir });
    const baseCommit = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();

    // tasklet1 (AI): inserts the discount-check line — a pure insertion,
    // attributed outright.
    fs.writeFileSync(filePath, [
      'def calculate_total(items):',
      '    total = 0',
      '    if len(items) > 10:',
      '    # end of discount check',
      '    return total',
      '',
    ].join('\n'));
    execSync('git add app.py', { cwd: dir });
    const aiCommit = commitAiEdit(dir, baseCommit, 'tasklet-1', 'sess1', 'add a discount check', 1000);
    execSync(`git update-ref refs/tracy-local/aaaa1111 ${aiCommit}`, { cwd: dir });

    // Finalize tasklet1's chain into a real commit, the way the extension
    // does on `git commit` — tracy-id note + refs/tracy/<id> pointing at
    // the hidden AI commit.
    execSync('git add -A && git commit -q -m "add discount check (AI assisted)"', { cwd: dir });
    execSync('git notes add -m "tracy-id: aaaa1111" HEAD', { cwd: dir });
    execSync(`git update-ref refs/tracy/aaaa1111 ${aiCommit}`, { cwd: dir });

    // A later, separate human commit tweaks the AI-written line AND makes
    // a trivial punctuation edit to the immediately adjacent comment (never
    // AI-attributed), with no unchanged line between them — git bundles
    // both into ONE hunk that's still similar enough overall to be
    // "insignificant". Before the fix, the whole hunk's new lines
    // (including the unrelated comment) were blanket-credited to tasklet1.
    fs.writeFileSync(filePath, [
      'def calculate_total(items):',
      '    total = 0',
      '    if len(items) >= 10:',
      '    # end of discount check.',
      '    return total',
      '',
    ].join('\n'));
    execSync('git add -A && git commit -q -m "human tweak both lines"', { cwd: dir });

    const result = await buildHistory(dir);
    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }

    const file = result.history.files.find(f => f.path === 'app.py');
    const tasklet = file?.tasklets.find(t => t.taskletId === 'tasklet-1');
    assert.ok(tasklet, 'tasklet-1 should still be attributed to the discount-check line');
    assert.deepStrictEqual(
      tasklet!.lines,
      [3],
      'only the AI-written line should be credited — the adjacent comment (never AI-authored) must not be swept in'
    );
  });
});

suite('buildHistory resolves significance against the real parent, not array adjacency', () => {
  test('a squash-merged, two-branch chain still filters a tiny edit whose real parent is the base commit', async () => {
    // getTracyChain() does a BFS over both parents of a squash-merge
    // commit, so array-adjacent chain entries can be siblings from
    // different branches rather than parent/child. Branch A's tiny edit
    // (> 10 -> >= 10) has the real base commit as its parent and should be
    // filtered as an insignificant User->AI change — even though branch
    // B's unrelated AI commit can land array-adjacent to it after the BFS
    // traversal reverses.
    const dir = makeTempDir();
    execSync('git init -q', { cwd: dir });
    execSync('git config user.email test@example.com', { cwd: dir });
    execSync('git config user.name Test', { cwd: dir });

    const filePath = path.join(dir, 'app.py');
    fs.writeFileSync(filePath, [
      'def calculate_total(items):',
      '    total = 0',
      '    if len(items) > 10:',
      '        total *= 0.9',
      '    return total',
      '',
      'def helper():',
      '    z = None',
      '    return z',
      '',
    ].join('\n'));
    execSync('git add app.py && git commit -q -m init', { cwd: dir });
    const baseCommit = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();

    // Branch A: a tiny, near-identical edit off the base commit.
    fs.writeFileSync(filePath, [
      'def calculate_total(items):',
      '    total = 0',
      '    if len(items) >= 10:',
      '        total *= 0.9',
      '    return total',
      '',
      'def helper():',
      '    z = None',
      '    return z',
      '',
    ].join('\n'));
    execSync('git add app.py', { cwd: dir });
    const commitA = commitAiEdit(dir, baseCommit, 'tasklet-A1', 'sessA', 'tiny tweak on branch A', 1000);

    // Branch B: a substantial, unrelated edit, ALSO off the base commit.
    execSync(`git read-tree ${baseCommit}^{tree}`, { cwd: dir });
    fs.writeFileSync(filePath, [
      'def calculate_total(items):',
      '    total = 0',
      '    if len(items) > 10:',
      '        total *= 0.9',
      '    return total',
      '',
      'def helper():',
      '    z = compute_something_entirely_different()',
      '    return z',
      '',
    ].join('\n'));
    execSync('git add app.py', { cwd: dir });
    const commitB = commitAiEdit(dir, baseCommit, 'tasklet-B1', 'sessB', 'unrelated edit on branch B', 2000);

    // Synthetic merge commit combining both branches, mimicking the
    // post-rewrite squash-merge hook described in getTracyChain()'s doc
    // comment.
    fs.writeFileSync(filePath, [
      'def calculate_total(items):',
      '    total = 0',
      '    if len(items) >= 10:',
      '        total *= 0.9',
      '    return total',
      '',
      'def helper():',
      '    z = compute_something_entirely_different()',
      '    return z',
      '',
    ].join('\n'));
    execSync('git add app.py', { cwd: dir });
    const mergeTree = execSync('git write-tree', { cwd: dir, encoding: 'utf8' }).trim();
    const mergeCommit = execSync(`git commit-tree ${mergeTree} -p ${commitA} -p ${commitB} -m "merge chains"`, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'Tracybot', GIT_AUTHOR_EMAIL: 'tracybot@local', GIT_COMMITTER_NAME: 'Tracybot', GIT_COMMITTER_EMAIL: 'tracybot@local' },
    }).trim();

    execSync(`git update-ref refs/tracy-local/aaaa1111 ${mergeCommit}`, { cwd: dir });
    execSync('git config tracy.current-id aaaa1111', { cwd: dir });
    execSync(`git reset -q --mixed ${baseCommit}`, { cwd: dir });
    fs.writeFileSync(filePath, [
      'def calculate_total(items):',
      '    total = 0',
      '    if len(items) >= 10:',
      '        total *= 0.9',
      '    return total',
      '',
      'def helper():',
      '    z = compute_something_entirely_different()',
      '    return z',
      '',
    ].join('\n'));

    const result = await buildHistory(dir);
    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }

    const file = result.history.files.find(f => f.path === 'app.py');
    const taskletA = file?.tasklets.find(t => t.taskletId === 'tasklet-A1');
    const taskletB = file?.tasklets.find(t => t.taskletId === 'tasklet-B1');

    assert.ok(
      !taskletA || taskletA.lines.length === 0,
      'branch A\'s tiny edit must be filtered — its real parent is the base commit, not branch B\'s AI snapshot'
    );
    assert.ok(taskletB, 'branch B\'s substantial edit should still be attributed');
    assert.ok(taskletB!.lines.length > 0, 'branch B\'s edit should still own a live line');
  });
});
