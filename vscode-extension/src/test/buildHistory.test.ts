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

suite('buildHistory aligns duplicate lines within a hunk one-to-one', () => {
  test('two identical AI-written lines bundled into one insignificant hunk both keep distinct attribution', async () => {
    // A naive per-line lookup (findIndex over the hunk's new lines) always
    // resolves a duplicated line to the SAME first occurrence — both old
    // duplicates collapse onto one new position, and the Set-based
    // survivor collection silently drops the second one. A proper
    // one-to-one, order-preserving alignment must keep them distinct.
    const dir = makeTempDir();
    execSync('git init -q', { cwd: dir });
    execSync('git config user.email test@example.com', { cwd: dir });
    execSync('git config user.name Test', { cwd: dir });

    const filePath = path.join(dir, 'app.py');
    fs.writeFileSync(filePath, [
      'def process(items):',
      '    return items',
      '',
    ].join('\n'));
    execSync('git add app.py && git commit -q -m init', { cwd: dir });
    const baseCommit = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();

    // tasklet1 (AI): inserts a loop with two identical log lines — a pure
    // insertion, both attributed outright.
    fs.writeFileSync(filePath, [
      'def process(items):',
      '    for item in items:',
      '        if item.valid:',
      '            log.debug("done")',
      '        else:',
      '            log.debug("done")',
      '    return items',
      '',
    ].join('\n'));
    execSync('git add app.py', { cwd: dir });
    const aiCommit = commitAiEdit(dir, baseCommit, 'tasklet-1', 'sess1', 'add a validation loop with debug logging', 1000);
    execSync(`git update-ref refs/tracy-local/aaaa1111 ${aiCommit}`, { cwd: dir });

    execSync('git add -A && git commit -q -m "add validation loop (AI assisted)"', { cwd: dir });
    execSync('git notes add -m "tracy-id: aaaa1111" HEAD', { cwd: dir });
    execSync(`git update-ref refs/tracy/aaaa1111 ${aiCommit}`, { cwd: dir });

    // A later, separate human commit reindents the whole block AND renames
    // a field, forcing git to bundle both duplicate lines into ONE hunk
    // that's still similar enough overall to be "insignificant".
    fs.writeFileSync(filePath, [
      'def process(items):',
      '  for item in items:',
      '    if item.is_valid:',
      '      log.debug("done")',
      '    else:',
      '      log.debug("done")',
      '  return items',
      '',
    ].join('\n'));
    execSync('git add -A && git commit -q -m "human reindents and renames"', { cwd: dir });

    const result = await buildHistory(dir);
    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }

    const file = result.history.files.find(f => f.path === 'app.py');
    const tasklet = file?.tasklets.find(t => t.taskletId === 'tasklet-1');
    assert.ok(tasklet, 'tasklet-1 should still be attributed to some of the loop');
    assert.deepStrictEqual(
      tasklet!.lines,
      [2, 4, 5, 6],
      'both duplicate log lines (4 and 6) must independently survive — neither should collapse onto the other'
    );
  });

  test('two different tasklets each owning one occurrence of a duplicated line keep their own distinct positions', async () => {
    // consumeAndShift is called separately per tasklet's own Change
    // (propagateChanges maps over each Change independently), so this
    // also exercises the cross-call case: two separate invocations against
    // the same hunk must still agree on which duplicate maps to which
    // tasklet, instead of one tasklet's line overwriting the other's.
    const dir = makeTempDir();
    execSync('git init -q', { cwd: dir });
    execSync('git config user.email test@example.com', { cwd: dir });
    execSync('git config user.name Test', { cwd: dir });

    const filePath = path.join(dir, 'app.py');
    fs.writeFileSync(filePath, [
      'def process(a, b):',
      '    pass',
      '',
    ].join('\n'));
    execSync('git add app.py && git commit -q -m init', { cwd: dir });
    const baseCommit = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();

    // tasklet1 (AI): adds branch a with a log line.
    fs.writeFileSync(filePath, [
      'def process(a, b):',
      '    if a:',
      '        log.info(\'processed\')',
      '    pass',
      '',
    ].join('\n'));
    execSync('git add app.py', { cwd: dir });
    const aiCommit1 = commitAiEdit(dir, baseCommit, 'tasklet-1', 'sess1', 'log when a is processed', 1000);
    execSync(`git update-ref refs/tracy-local/aaaa1111 ${aiCommit1}`, { cwd: dir });
    execSync('git add -A && git commit -q -m "log when a is processed (AI assisted)"', { cwd: dir });
    const commitA = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
    execSync('git notes add -m "tracy-id: aaaa1111" HEAD', { cwd: dir });
    execSync(`git update-ref refs/tracy/aaaa1111 ${aiCommit1}`, { cwd: dir });

    // tasklet2 (AI, a SEPARATE later chain): adds an IDENTICAL log line for
    // branch b.
    fs.writeFileSync(filePath, [
      'def process(a, b):',
      '    if a:',
      '        log.info(\'processed\')',
      '    if b:',
      '        log.info(\'processed\')',
      '    pass',
      '',
    ].join('\n'));
    execSync('git add app.py', { cwd: dir });
    const aiCommit2 = commitAiEdit(dir, commitA, 'tasklet-2', 'sess2', 'also log when b is processed', 2000);
    execSync(`git update-ref refs/tracy-local/bbbb2222 ${aiCommit2}`, { cwd: dir });
    execSync('git add -A && git commit -q -m "also log when b is processed (AI assisted)"', { cwd: dir });
    execSync('git notes add -m "tracy-id: bbbb2222" HEAD', { cwd: dir });
    execSync(`git update-ref refs/tracy/bbbb2222 ${aiCommit2}`, { cwd: dir });

    // Human commit: reindents the whole region, bundling both duplicates
    // into one hunk.
    fs.writeFileSync(filePath, [
      'def process(a, b):',
      '  if a:',
      '    log.info(\'processed\')',
      '  if b:',
      '    log.info(\'processed\')',
      '  pass',
      '',
    ].join('\n'));
    execSync('git add -A && git commit -q -m "human reindents"', { cwd: dir });

    const result = await buildHistory(dir);
    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }

    const file = result.history.files.find(f => f.path === 'app.py');
    const tasklet1 = file?.tasklets.find(t => t.taskletId === 'tasklet-1');
    const tasklet2 = file?.tasklets.find(t => t.taskletId === 'tasklet-2');

    assert.deepStrictEqual(tasklet1?.lines, [2, 3], 'tasklet-1 should keep its own branch-a lines');
    assert.deepStrictEqual(tasklet2?.lines, [4, 5], 'tasklet-2 should keep its own branch-b lines, not tasklet-1\'s');
  });
});

suite('buildHistory stays fast and memory-bounded on a large single hunk', () => {
  test('reformatting a large AI-generated file (one big insignificant hunk) resolves quickly without excess memory growth', async function () {
    // A full-file reformat (e.g. running a formatter over an AI-generated
    // file) touches every line, so git can produce ONE hunk spanning the
    // whole file — thousands of lines on both sides. An O(n*m) alignment
    // (a full LCS table) would allocate on the order of n*m number slots
    // for that single hunk: harmless at a few hundred lines, but hundreds
    // of MB to GB once a hunk reaches the thousands, which a large
    // generated file crosses easily. The alignment must stay roughly
    // linear in hunk size instead.
    this.timeout(20000);

    const lineCount = 5000;
    const dir = makeTempDir();
    execSync('git init -q', { cwd: dir });
    execSync('git config user.email test@example.com', { cwd: dir });
    execSync('git config user.name Test', { cwd: dir });

    const filePath = path.join(dir, 'app.py');
    fs.writeFileSync(filePath, '# placeholder\n');
    execSync('git add app.py && git commit -q -m init', { cwd: dir });
    const baseCommit = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();

    const buildLines = (indent: string) => {
      const out = ['def process():'];
      for (let i = 0; i < lineCount; i++) {
        out.push(`${indent}log.debug("line ${i}")`);
      }
      out.push(`${indent}return None`);
      out.push('');
      return out.join('\n');
    };

    fs.writeFileSync(filePath, buildLines('    '));
    execSync('git add app.py', { cwd: dir });
    const aiCommit = commitAiEdit(dir, baseCommit, 'tasklet-1', 'sess1', 'generate a large function', 1000);
    execSync(`git update-ref refs/tracy-local/aaaa1111 ${aiCommit}`, { cwd: dir });
    execSync('git add -A && git commit -q -m "generate large function (AI assisted)"', { cwd: dir });
    execSync('git notes add -m "tracy-id: aaaa1111" HEAD', { cwd: dir });
    execSync(`git update-ref refs/tracy/aaaa1111 ${aiCommit}`, { cwd: dir });

    // Human commit: reindent the entire block — every line changes, so the
    // whole thing lands in one hunk that's still similarity-wise
    // "insignificant" (whitespace is stripped before comparison).
    fs.writeFileSync(filePath, buildLines('  '));
    execSync('git add -A && git commit -q -m "human reindents the whole file"', { cwd: dir });

    const heapBefore = process.memoryUsage().heapUsed;
    const startedAt = Date.now();
    const result = await buildHistory(dir);
    const elapsedMs = Date.now() - startedAt;
    const heapGrowthMb = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);

    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }

    const file = result.history.files.find(f => f.path === 'app.py');
    const tasklet = file?.tasklets.find(t => t.taskletId === 'tasklet-1');
    assert.ok(tasklet, 'the large reformatted function should still be attributed');
    assert.strictEqual(
      tasklet!.lines.length,
      lineCount + 2,
      'every reformatted line (plus the def and return lines) should still resolve to its own distinct position'
    );

    assert.ok(
      elapsedMs < 5000,
      `expected a ${lineCount}-line single-hunk alignment to resolve in well under 5s, took ${elapsedMs}ms — an O(n*m) alignment would scale quadratically here`
    );
    assert.ok(
      heapGrowthMb < 150,
      `expected heap growth well under 150MB for a ${lineCount}-line hunk, saw ${heapGrowthMb.toFixed(1)}MB — an O(n*m) alignment table would allocate on the order of ${lineCount}^2 number slots`
    );
  });

  test('a large hunk where every line is identical resolves without quadratic slowdown', async function () {
    // The previous test's lines are all distinct, so it can't catch a
    // different cost: consuming a per-content bucket of matched new-line
    // indices via Array.prototype.shift() is O(k) per call — shift()
    // shifts every remaining element down by one — so repeatedly shifting
    // the SAME bucket (which is exactly what happens when a hunk has many
    // identical lines: `}`, blank lines, templated log statements) costs
    // O(k^2) for that bucket alone, even though the rest of the alignment
    // is linear. This needs a much larger line count than the previous
    // test before that quadratic term dominates the (still-linear) cost
    // of everything else in the pipeline (diff parsing, file I/O).
    this.timeout(60000);

    const lineCount = 300000;
    const dir = makeTempDir();
    execSync('git init -q', { cwd: dir });
    execSync('git config user.email test@example.com', { cwd: dir });
    execSync('git config user.name Test', { cwd: dir });

    const filePath = path.join(dir, 'app.py');
    fs.writeFileSync(filePath, '# placeholder\n');
    execSync('git add app.py && git commit -q -m init', { cwd: dir });
    const baseCommit = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();

    const buildLines = (indent: string) => {
      const out = ['def process():'];
      for (let i = 0; i < lineCount; i++) {
        out.push(`${indent}log.debug("tick")`);
      }
      out.push(`${indent}return None`);
      out.push('');
      return out.join('\n');
    };

    fs.writeFileSync(filePath, buildLines('    '));
    execSync('git add app.py', { cwd: dir });
    const aiCommit = commitAiEdit(dir, baseCommit, 'tasklet-1', 'sess1', 'generate a large function with repeated log lines', 1000);
    execSync(`git update-ref refs/tracy-local/aaaa1111 ${aiCommit}`, { cwd: dir });
    execSync('git add -A && git commit -q -m "generate large function (AI assisted)"', { cwd: dir });
    execSync('git notes add -m "tracy-id: aaaa1111" HEAD', { cwd: dir });
    execSync(`git update-ref refs/tracy/aaaa1111 ${aiCommit}`, { cwd: dir });

    // Human commit: reindent the entire block of identical lines — one
    // giant hunk, one giant content bucket.
    fs.writeFileSync(filePath, buildLines('  '));
    execSync('git add -A && git commit -q -m "human reindents the whole file"', { cwd: dir });

    const startedAt = Date.now();
    const result = await buildHistory(dir);
    const elapsedMs = Date.now() - startedAt;

    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }

    const file = result.history.files.find(f => f.path === 'app.py');
    const tasklet = file?.tasklets.find(t => t.taskletId === 'tasklet-1');
    assert.ok(tasklet, 'the large reformatted function should still be attributed');
    assert.strictEqual(
      tasklet!.lines.length,
      lineCount + 2,
      'every reformatted line (plus the def and return lines) should still resolve to its own distinct position'
    );

    // Measured on a dev machine: a cursor-based bucket consumption
    // resolves this in ~6s; the pre-fix Array.shift()-based consumption
    // took ~11.7s for the same input. The bound below leaves generous
    // margin over the fixed-code time for slower CI hardware while still
    // sitting below the pre-fix time.
    assert.ok(
      elapsedMs < 10000,
      `expected a ${lineCount}-line single-hunk alignment with all-identical content to resolve in well under 10s, took ${elapsedMs}ms — repeatedly Array.shift()-ing the same content bucket is O(k^2) for a bucket of this size`
    );
  });

  test('a large uniform rename with no exact matches still attributes every line, not just the untouched ones', async function () {
    // A prior version of the BLEU fallback gated the ENTIRE pass on the
    // total unmatched-old x unmatched-new product: past a fixed cap, it
    // skipped fuzzy matching altogether rather than searching less. A
    // uniform rename applied throughout a large AI-generated block (every
    // line references the renamed identifier, so NOTHING exact-matches
    // after the rename) crosses that cap easily and lost attribution for
    // the whole hunk — not a precision trade-off, a functional regression,
    // since this is exactly the case the fallback exists to handle.
    this.timeout(30000);

    const lineCount = 500; // 500*500 = 250,000, over the old 200,000 cap
    const dir = makeTempDir();
    execSync('git init -q', { cwd: dir });
    execSync('git config user.email test@example.com', { cwd: dir });
    execSync('git config user.name Test', { cwd: dir });

    const filePath = path.join(dir, 'app.py');
    fs.writeFileSync(filePath, '# placeholder\n');
    execSync('git add app.py && git commit -q -m init', { cwd: dir });
    const baseCommit = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();

    const buildLines = (fieldName: string) => {
      const out = ['def process(items):'];
      for (let i = 0; i < lineCount; i++) {
        out.push(`    record${i} = load(${fieldName}=${i})`);
      }
      out.push('    return None');
      out.push('');
      return out.join('\n');
    };

    fs.writeFileSync(filePath, buildLines('user_id'));
    execSync('git add app.py', { cwd: dir });
    const aiCommit = commitAiEdit(dir, baseCommit, 'tasklet-1', 'sess1', 'generate a large function using user_id', 1000);
    execSync(`git update-ref refs/tracy-local/aaaa1111 ${aiCommit}`, { cwd: dir });
    execSync('git add -A && git commit -q -m "generate large function (AI assisted)"', { cwd: dir });
    execSync('git notes add -m "tracy-id: aaaa1111" HEAD', { cwd: dir });
    execSync(`git update-ref refs/tracy/aaaa1111 ${aiCommit}`, { cwd: dir });

    // Human commit: rename user_id -> userId everywhere. Every line
    // changes (nothing exact-matches), but each is still highly similar
    // to its own counterpart.
    fs.writeFileSync(filePath, buildLines('userId'));
    execSync('git add -A && git commit -q -m "human renames user_id to userId everywhere"', { cwd: dir });

    const result = await buildHistory(dir);
    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }

    const file = result.history.files.find(f => f.path === 'app.py');
    const tasklet = file?.tasklets.find(t => t.taskletId === 'tasklet-1');
    assert.ok(tasklet, 'the large renamed function should still be attributed');
    assert.strictEqual(
      tasklet!.lines.length,
      lineCount + 2,
      'every renamed line (plus the def and return lines) should still resolve to its own position — not just the two untouched lines'
    );
  });

  test('lines inserted before a large rename do not pull AI-attributed lines onto the wrong occurrence', async function () {
    // Code review finding: a fixed-size proportional estimate assumes the
    // hunk's own line-count change is spread evenly across it. If it's
    // actually concentrated at one end — e.g. a block of lines inserted
    // right before a large renamed section — an old line near that end
    // gets an estimate that's off by roughly the insertion size, and if
    // something else in the hunk happens to be near-duplicate content
    // (templated code very often is), the search can settle on that wrong
    // occurrence via early exit before ever reaching the real one, which
    // sits further out but still within the search window.
    //
    // This reproduces it precisely: 50 lines are inserted right before
    // tasklet-1's 500-line renamed block, reusing indices 0..49 with
    // content that becomes BYTE-IDENTICAL to the first 50 lines of
    // tasklet-1's own (renamed) block — the sharpest version of "templated
    // lines that are highly similar to each other." A naive estimate
    // lands the search right on the inserted duplicate first.
    this.timeout(20000);

    const lineCount = 500;
    const insertedCount = 50;
    const dir = makeTempDir();
    execSync('git init -q', { cwd: dir });
    execSync('git config user.email test@example.com', { cwd: dir });
    execSync('git config user.name Test', { cwd: dir });

    const filePath = path.join(dir, 'app.py');
    fs.writeFileSync(filePath, '# placeholder\n');
    execSync('git add app.py && git commit -q -m init', { cwd: dir });
    const baseCommit = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();

    const buildAiLines = () => {
      const out = ['def process(items):'];
      for (let i = 0; i < lineCount; i++) {
        out.push(`    record${i} = load(user_id=${i})`);
      }
      out.push('    return None');
      out.push('');
      return out.join('\n');
    };

    fs.writeFileSync(filePath, buildAiLines());
    execSync('git add app.py', { cwd: dir });
    const aiCommit = commitAiEdit(dir, baseCommit, 'tasklet-1', 'sess1', 'generate a large function using user_id', 1000);
    execSync(`git update-ref refs/tracy-local/aaaa1111 ${aiCommit}`, { cwd: dir });
    execSync('git add -A && git commit -q -m "generate large function (AI assisted)"', { cwd: dir });
    execSync('git notes add -m "tracy-id: aaaa1111" HEAD', { cwd: dir });
    execSync(`git update-ref refs/tracy/aaaa1111 ${aiCommit}`, { cwd: dir });

    // Human commit: insert 50 lines reusing indices 0..49 right before the
    // block, and rename user_id -> userId across the real block too. After
    // the rename, indices 0..49 exist twice in the new file — once as the
    // inserted lines, once as the true (shifted) AI content, byte-
    // identical to each other.
    const buildRenamedLines = () => {
      const out = ['def process(items):'];
      for (let i = 0; i < insertedCount; i++) {
        out.push(`    record${i} = load(userId=${i})`);
      }
      for (let i = 0; i < lineCount; i++) {
        out.push(`    record${i} = load(userId=${i})`);
      }
      out.push('    return None');
      out.push('');
      return out.join('\n');
    };
    fs.writeFileSync(filePath, buildRenamedLines());
    execSync('git add -A && git commit -q -m "human inserts duplicate-numbered lines and renames user_id to userId"', { cwd: dir });

    const result = await buildHistory(dir);
    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }

    const file = result.history.files.find(f => f.path === 'app.py');
    const tasklet = file?.tasklets.find(t => t.taskletId === 'tasklet-1');
    assert.ok(tasklet, 'the large renamed function should still be attributed');

    // The inserted duplicate occupies new lines [2, 1 + insertedCount].
    // None of tasklet-1's own lines should land there.
    const wrongRangeStart = 2;
    const wrongRangeEnd = 1 + insertedCount;
    const misattributed = tasklet!.lines.filter(l => l >= wrongRangeStart && l <= wrongRangeEnd);
    assert.deepStrictEqual(
      misattributed,
      [],
      `expected none of tasklet-1's lines to land in the inserted-duplicate range [${wrongRangeStart},${wrongRangeEnd}], got ${JSON.stringify(misattributed)}`
    );
  });

  test('a large hunk of uniformly-renamed identical lines resolves without stalling or drifting off position', async function () {
    // Two code review findings share this one repro. A hunk where every
    // old line is identical to every other (a real pattern: the same
    // templated statement repeated verbatim thousands of times) and gets
    // uniformly renamed, with no lines inserted or deleted, means every
    // old line's fuzzy search sees thousands of candidates that ALL score
    // identically:
    //
    // 1. Preferring the farther-explored candidate on an exact tie (added
    //    so a real match isn't lost to an earlier, wrong-but-equally-
    //    scoring one) originally marked every tie as "progress", resetting
    //    the patience counter — so patience never accumulated and every
    //    line scanned the full search window. Reproduced a ~13x slowdown
    //    (~2s fixed vs ~26s before) at 5,000 lines.
    // 2. Once ties stopped resetting patience, "always prefer the
    //    farther-explored tie" was still wrong when nothing actually
    //    shifted (no size change in this hunk, so the natural position for
    //    each line is unchanged) — it systematically walked every line's
    //    pick toward the edge of the search window, losing the earliest
    //    lines instead of matching them where they already were.
    this.timeout(20000);

    const lineCount = 5000;
    const dir = makeTempDir();
    execSync('git init -q', { cwd: dir });
    execSync('git config user.email test@example.com', { cwd: dir });
    execSync('git config user.name Test', { cwd: dir });

    const filePath = path.join(dir, 'app.py');
    fs.writeFileSync(filePath, '# placeholder\n');
    execSync('git add app.py && git commit -q -m init', { cwd: dir });
    const baseCommit = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();

    const buildLines = (fieldName: string) => {
      const out = ['def process():'];
      for (let i = 0; i < lineCount; i++) {
        out.push(`    record = load(${fieldName}=value)`);
      }
      out.push('    return None');
      out.push('');
      return out.join('\n');
    };

    fs.writeFileSync(filePath, buildLines('user_id'));
    execSync('git add app.py', { cwd: dir });
    const aiCommit = commitAiEdit(dir, baseCommit, 'tasklet-1', 'sess1', 'generate a large function using user_id repeatedly', 1000);
    execSync(`git update-ref refs/tracy-local/aaaa1111 ${aiCommit}`, { cwd: dir });
    execSync('git add -A && git commit -q -m "generate large function (AI assisted)"', { cwd: dir });
    execSync('git notes add -m "tracy-id: aaaa1111" HEAD', { cwd: dir });
    execSync(`git update-ref refs/tracy/aaaa1111 ${aiCommit}`, { cwd: dir });

    // Human commit: rename user_id -> userId across every (identical)
    // line at once.
    fs.writeFileSync(filePath, buildLines('userId'));
    execSync('git add -A && git commit -q -m "human renames user_id to userId everywhere"', { cwd: dir });

    const startedAt = Date.now();
    const result = await buildHistory(dir);
    const elapsedMs = Date.now() - startedAt;

    assert.strictEqual(result.ok, true);
    if (!result.ok) { return; }

    const file = result.history.files.find(f => f.path === 'app.py');
    const tasklet = file?.tasklets.find(t => t.taskletId === 'tasklet-1');
    assert.ok(tasklet, 'the large renamed function should still be attributed');
    // With every line identical to every other, which specific line
    // "belongs" to which is genuinely ambiguous — a handful can be lost
    // at the margins without it being a correctness bug. The overwhelming
    // majority resolving is what matters here.
    assert.ok(
      tasklet!.lines.length > lineCount * 0.95,
      `expected the vast majority of ${lineCount} identical renamed lines to still resolve, got ${tasklet!.lines.length}`
    );

    // Count alone isn't enough: a systematic bias toward farther-explored
    // ties can preserve nearly the full count while shifting every one of
    // them off their natural (unshifted) position — losing the earliest
    // lines instead of a random scatter. There's no size change here
    // (oldCount === newCount), so the natural, unshifted range is exactly
    // [1, lineCount + 2] (the def line through the return line). A shift
    // shows up as the observed minimum climbing well above 1.
    const sortedLines = tasklet!.lines.slice().sort((a, b) => a - b);
    assert.ok(
      sortedLines[0] <= 3,
      `expected attribution to start at or near line 1 (no size change here, so nothing should need to shift) — the lowest attributed line was ${sortedLines[0]}, suggesting matches drifted toward one end of the search window`
    );

    assert.ok(
      elapsedMs < 8000,
      `expected a ${lineCount}-line hunk of identical, uniformly-renamed lines to resolve in well under 8s, took ${elapsedMs}ms — ties resetting the early-exit patience counter would force a full-window scan for every line`
    );
  });
});
