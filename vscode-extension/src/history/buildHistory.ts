import { BuildHistoryFailureReason, BuildHistoryResult, Change, CommitInfo, DiffHunk, History, TaskletMessage, TaskletQuestion } from "./types";
import {
  bleuSimilarity,
  getActiveTracyId,
  getCommitTree,
  getDiff,
  getTracyLocalRefCommit,
  getTracyRefCommit,
  groupChangesByFile,
  isAiChange,
  mapLinesToTree,
  runGit,
  SIMILARITY_THRESHOLD
} from "../utils";

const DELIMITER = "||#--TRACY--#||";

// Key: git commit hash
let commitHistoryCache: Map<string, Change[]> = new Map();

export function hydrateCache(serialized: Record<string, Change[]> | undefined) {
  if (!serialized) {
    return;
  }

  const entries: [string, Change[]][] = Object.entries(serialized).map(([k, changes]) => [
    k,
    changes.map(c => ({ ...c, ghostLines: c.ghostLines ?? [], diffHunks: c.diffHunks ?? [] })),
  ]);
  commitHistoryCache = new Map(entries);
}

export function getSerializedCache(): Record<string, Change[]> {
  return Object.fromEntries(commitHistoryCache);
}

export function clearCache(): void {
  commitHistoryCache.clear();
}

async function getMainCommits(repoPath: string): Promise<CommitInfo[]> {
  // %x00 terminates each record with a null byte so multi-line %b bodies
  // don't split a commit across multiple lines when we iterate the output.
  const output = await runGit(repoPath, [
    "log",
    "--reverse",
    `--format=%H${DELIMITER}%ae${DELIMITER}%an${DELIMITER}%s${DELIMITER}%b${DELIMITER}%P${DELIMITER}%T${DELIMITER}%aI${DELIMITER}%cI%x00`,
  ]);

  if (!output) {
    return [];
  }

  const commits: CommitInfo[] = [];
  for (const record of output.split("\x00")) {
    const trimmed = record.trim();
    if (!trimmed) {
      continue;
    }

    const parts = trimmed.split(DELIMITER);
    if (parts.length < 9) {
      console.warn(`Skipping malformed commit line: expected 9 fields, got ${parts.length}`);
      continue;
    }

    const [hash, authorEmail, authorName, message, description, parentHash, treeHash, authorDate, committerDate] = parts;

    if (!treeHash) {
      console.warn(`Missing treeHash for commit ${hash}, fetching directly`);
      const fetchedTree = await getCommitTree(repoPath, hash);
      if (!fetchedTree) {
        console.warn(`Could not fetch tree for commit ${hash}, skipping`);
        continue;
      }
      commits.push({
        hash,
        authorEmail,
        authorName,
        message,
        description,
        parentHash: parentHash || null,
        treeHash: fetchedTree,
        authorDate,
        committerDate
      });
      continue;
    }
    commits.push({
      hash,
      authorEmail,
      authorName,
      message,
      description,
      parentHash: parentHash || null,
      treeHash,
      authorDate,
      committerDate
    });
  }

  return commits;
}

async function getTracyIdNote(repoPath: string, commitHash: string): Promise<string | null> {
  try {
    const output = await runGit(repoPath, ["notes", "show", commitHash]);
    const match = output.match(/tracy-id:\s*([a-f0-9@-]+)/);

    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function isOnAnyBranch(repoPath: string, hash: string): Promise<boolean> {
  try {
    const result = await runGit(repoPath, ["branch", "--contains", hash, "--no-color"]);
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

// When you squash multiple commits in git, the original commits are 
// replaced by a new single commit. However, each original commit may have 
// its own hidden chain containing AI snapshots.
// 
// Example:
// Before squash, you have two commits:
//
// Commit A (Add payment tests) - tracy-id: AAAAA
//   - hidden chain: AI snapshot 1 -> AI snapshot 2
// Commit B (Snapshot for Tracybot) - tracy-id: BBBBB  
//   - hidden chain: AI snapshot 3 -> AI snapshot 4
//
// After squash (git reset + git commit):
//
// Squashed commit (contains both A and B) - tracy-id: CCCCC
//   - hidden chain: wtf??? (what goes here?)
//
// The post-rewrite hook creates a merge commit that has two parents:
// Merged chain commit (DDDDD)
//   - parent 1: AI snapshot 2 (from A's chain)
//   - parent 2: AI snapshot 3 (from B's chain, contains the Stripe AI change)
//
// Traversing linearly would follow only the first parent (AI snapshot 2) 
// BFS follows all parents. This ensures AI snapshots from the squashed 
// branch (parent 2) are found, so that the history correctly shows both the 
// AI snapshot 2 change and and AI snapshot 1 change as separate tasklets.
async function getTracyChain(repoPath: string, startCommit: string): Promise<CommitInfo[]> {
  const commits: CommitInfo[] = [];
  const visited = new Set<string>();
  const queue: string[] = [startCommit];

  while (queue.length > 0) {
    const currentHash = queue.shift()!;

    if (visited.has(currentHash)) {
      continue;
    }

    visited.add(currentHash);

    try {
      // Commit info in format: hash|email|name|subject|body|parent|tree|authorDate|committerDate
      const output = await runGit(repoPath, [
        "log",
        "-1",
        `--format=%H${DELIMITER}%ae${DELIMITER}%an${DELIMITER}%s${DELIMITER}%b${DELIMITER}%P${DELIMITER}%T${DELIMITER}%aI${DELIMITER}%cI`,
        currentHash
      ]);

      if (!output) {
        continue;
      }

      const [hash, authorEmail, authorName, message, description, parentHash, treeHash, authorDate, committerDate] = output.split(DELIMITER);
      commits.push({
        hash,
        authorEmail,
        authorName,
        message,
        description,
        parentHash: parentHash || null,
        treeHash: treeHash,
        authorDate,
        committerDate
      });

      // Stop traversal at commits reachable from refs/heads — those are origin
      // commits that anchor the diff baseline, not part of the hidden chain.
      const onBranch = await isOnAnyBranch(repoPath, hash);
      if (onBranch) {
        continue;
      }

      // Follow parents of hidden chain commits. Merge commits have space-separated parents.
      if (parentHash && parentHash.includes(" ")) {
        const allParents = parentHash.split(" ");

        // Add each parent to queue if not visited
        for (const parent of allParents) {
          if (!visited.has(parent)) {
            queue.push(parent);
          }
        }
      } else if (parentHash) {
        queue.push(parentHash);
      }
    } catch {
      continue;
    }
  }

  return commits.reverse();
}

interface TaskletMessagesResult {
  messages: TaskletMessage[];
  title: string;
  taskletId?: string;
  sessionId?: string;
  questions?: TaskletQuestion[];
  taskletGeneratedAt?: number | null;
  buildCompletedAt?: number | null;
  agentSource: "opencode" | "claude-code" | "codex";
}

// Dispatches on the parsed object's `source` field so History's downstream
// logic (line tracking, ownership, Research Mode extraction) never has to
// know which agent produced a given snapshot — every agent's description
// gets normalized into the same TaskletMessagesResult shape here, once.
function buildTaskletMessages(tasklet_str: string): TaskletMessagesResult {
  let tasklet_obj: any;

  try {
    tasklet_obj = JSON.parse(tasklet_str);
  } catch (e) {
    console.error(`Could not parse tasklet: ${tasklet_str}`);
    return { messages: [], title: "skill issue", agentSource: "opencode" };
  }

  if (!tasklet_obj) {
    console.error(`Could not parse tasklet: ${tasklet_str}`);
    return { messages: [], title: "skill issue", agentSource: "opencode" };
  }

  if (tasklet_obj.source === "claude-code" || tasklet_obj.source === "codex") {
    return parseFlatTurn(tasklet_obj, tasklet_obj.source);
  }

  return parseOpenCodeTasklet(tasklet_obj, tasklet_str);
}

// Claude Code and Codex both lack OpenCode's Plan/Build split, and both
// produce the same flat {prompt, response, ...} shape (see ClaudeTurn /
// CodexTurn in their respective plugin packages) — the whole turn is
// recorded under the "build" stage so downstream consumers (Research Mode's
// has_build/build_prompt fields in particular) keep working without needing
// to know which non-OpenCode agent shape they're looking at.
function parseFlatTurn(turn: any, agentSource: "claude-code" | "codex"): TaskletMessagesResult {
  const messages: TaskletMessage[] = [
    { stage: "build", type: "prompt", model: turn.model, message: turn.prompt ?? "" },
    { stage: "build", type: "response", model: turn.model, message: turn.response ?? "" },
  ];

  return {
    messages,
    title: turn.prompt ?? `${agentSource} edit`,
    taskletId: turn.id,
    sessionId: turn.sessionId,
    questions: [],
    taskletGeneratedAt: turn.promptCreatedAt ?? null,
    buildCompletedAt: turn.responseCompletedAt ?? null,
    agentSource,
  };
}

function parseOpenCodeTasklet(tasklet_obj: any, tasklet_str: string): TaskletMessagesResult {
  let messages: TaskletMessage[] = [];
  let title = "skill issue";

  title = tasklet_obj.title ?? "skill issue";

  // Handle questions and answers
  const allQuestions: any[] = Array.isArray(tasklet_obj.questions) ? tasklet_obj.questions : [];
  const questionsByOutputId = new Map<string, any[]>();
  for (const q of allQuestions) {
    if (!questionsByOutputId.has(q.outputId)) {
      questionsByOutputId.set(q.outputId, []);
    }
    questionsByOutputId.get(q.outputId)!.push(q);
  }

  // Append questions and answers to the corresponding response message based on outputId
  const appendQuestions = (response: string, outputId: string): string => {
    const questions = questionsByOutputId.get(outputId);
    if (!questions?.length) { return response; }
    const formatted = questions.map((q: any) => `Q: ${q.question}\n\nA: ${q.answer.join(", ")}`).join("\n\n");
    return response + "\n\n---\n\n" + formatted;
  };

  if (tasklet_obj?.planOutputs && Array.isArray(tasklet_obj.planOutputs)) {
    tasklet_obj.planOutputs.forEach((plan: any) => {
      if (plan.prompt) {
        messages.push({ stage: "plan", type: "prompt", model: plan.model, message: plan.prompt });
      }

      if (plan.response) {
        messages.push({ stage: "plan", type: "response", model: plan.model, message: appendQuestions(plan.response, plan.id) });
      }
    });
  }

  if (!tasklet_obj.buildOutput) {
    console.warn(`Missing build output in tasklet: ${tasklet_str}`);
  } else {
    messages.push({ stage: "build", type: "prompt", model: tasklet_obj.buildOutput?.model, message: tasklet_obj.buildOutput?.prompt });
    messages.push({ stage: "build", type: "response", model: tasklet_obj.buildOutput?.model, message: appendQuestions(tasklet_obj.buildOutput?.response ?? "", tasklet_obj.buildOutput?.id) });
  }

  // Tasklet started at the first plan prompt, or the build prompt if there was no plan stage
  const firstPlanPrompt = Array.isArray(tasklet_obj.planOutputs) ? tasklet_obj.planOutputs[0] : undefined;
  const taskletGeneratedAt: number | null =
    firstPlanPrompt?.promptCreatedAt ?? tasklet_obj.buildOutput?.promptCreatedAt ?? null;
  const buildCompletedAt: number | null = tasklet_obj.buildOutput?.responseCompletedAt ?? null;

  return {
    messages,
    title,
    taskletId: tasklet_obj.id,
    sessionId: tasklet_obj.sessionId,
    questions: allQuestions,
    taskletGeneratedAt,
    buildCompletedAt,
    agentSource: "opencode",
  };
}

async function extractChangesFromSnapshotChain(
  repoPath: string,
  chain: CommitInfo[],
  baseTree: string,
  targetTree: string | "WORKING_DIR",
  originCommit?: CommitInfo
): Promise<Change[]> {
  const results = await Promise.all(
    chain.map(async (snapshot, index) => {
      return extractSnapshot(repoPath, snapshot, chain, baseTree, index, targetTree, originCommit);
    })
  );

  return results.flat();
}

async function extractSnapshot(
  repoPath: string,
  snapshot: CommitInfo,
  chain: CommitInfo[],
  baseTree: string,
  index: number,
  targetTree: string | "WORKING_DIR",
  originCommit?: CommitInfo
): Promise<Change[]> {
  if (!isAiChange(snapshot)) {
    return [];
  }

  const {
    messages,
    title,
    taskletId,
    sessionId,
    questions,
    taskletGeneratedAt,
    buildCompletedAt,
    agentSource,
  } = buildTaskletMessages(snapshot.description);
  let diffFromTree = index > 0 ? chain[index - 1].treeHash : baseTree;
  // chain[index-1] (array-adjacent) is only a reliable stand-in for "this
  // snapshot's actual parent" on a simple linear chain. getTracyChain()
  // does a BFS over possibly-multiple parents to support squash-merged
  // chains (see its doc comment above), so on a chain with a merge point,
  // array-adjacent entries can be siblings from different branches rather
  // than parent/child. Default to the array-adjacent check and only
  // override it below once the real single parent is resolved.
  let diffBaseIsAiAuthored = index > 0 && isAiChange(chain[index - 1]);

  if (snapshot.parentHash) {
    const parentHashes = snapshot.parentHash.split(" ").filter(Boolean);

    // A multi-parent parentHash (merge commit) isn't resolvable by
    // getCommitTree (git rejects the space-joined string as a single
    // revision), so diffFromTree already silently falls back to the
    // array-adjacent tree above for that case — keep diffBaseIsAiAuthored
    // consistent with whatever diffFromTree actually ends up being.
    if (parentHashes.length === 1) {
      const parentTree = await getCommitTree(repoPath, parentHashes[0]);

      if (parentTree) {
        diffFromTree = parentTree;
        const actualParent = chain.find(c => c.hash === parentHashes[0]);
        diffBaseIsAiAuthored = actualParent ? isAiChange(actualParent) : false;
      }
    }
  }

  const fileChangesMap = await getDiff(repoPath, diffFromTree, snapshot.treeHash);
  const fileResults = await Promise.all(
    Array.from(fileChangesMap.keys()).map(async (filePath) => {
      const hunks = fileChangesMap.get(filePath) || [];

      // Only filter by significance when diffing against non-AI content
      // (the real User->AI case). Skipping the filter for AI->AI hops
      // matters because a hunk diffed against the AI's OWN prior edit is
      // very often textually close to it (small follow-up prompts, or
      // just the unchanged surrounding context dominating the score),
      // which isn't the "insignificant" case this filter exists to catch.
      const significantHunks = diffBaseIsAiAuthored ? hunks : hunks.filter(h => h.isSignificant);
      const linesAtSnapshot: number[] = [];
      for (const hunk of significantHunks) {
        for (let i = 0; i < hunk.newCount; i++) {
          linesAtSnapshot.push(hunk.newStart + i);
        }
      }

      const lines = await mapLinesToTree(
        repoPath,
        snapshot.treeHash,
        targetTree,
        filePath,
        linesAtSnapshot
      );

      const userDiffMap = await getDiff(
        repoPath,
        snapshot.treeHash,
        targetTree,
        filePath
      );

      const userHunks = userDiffMap.get(filePath) || [];

      const filteredLines = lines.filter((line) => {
        return !userHunks.some((hunk) => {
          return (
            line >= hunk.oldStart &&
            line < hunk.oldStart + hunk.oldCount
          );
        });
      });

      if (filteredLines.length > 0) {
        return {
          filePath,
          lines: filteredLines,
          ghostLines: [],
          model: snapshot.authorName,
          name: title,
          tasklet_messages: messages,
          snapshotHash: snapshot.hash,
          originCommitHash: originCommit?.hash,
          taskletId,
          sessionId,
          questions,
          taskletGeneratedAt,
          buildCompletedAt,
          originCommitAuthorDate: originCommit?.authorDate,
          originCommitCommitterDate: originCommit?.committerDate,
          diffHunks: hunks,
          agentSource,
        } as Change;
      }

      return null;
    })
  );

  return fileResults.filter((result) => result !== null);
}

async function propagateChanges(
  repoPath: string,
  changes: Change[],
  fromTree: string,
  toTree: string
): Promise<Change[]> {
  if (changes.length === 0 || fromTree === toTree) {
    return changes;
  }

  const byFile = new Map<string, Change[]>();
  for (const change of changes) {
    if (!byFile.has(change.filePath)) {
      byFile.set(change.filePath, []);
    }

    byFile.get(change.filePath)!.push(change);
  }

  const results = await Promise.all(
    Array.from(byFile.entries())
      .map(async ([filePath, fileChanges]) => {
        const diffMap = await getDiff(repoPath, fromTree, toTree, filePath);
        const hunks = diffMap.get(filePath) || [];
        if (hunks.length === 0) {
          return fileChanges;
        }

        return fileChanges.map(change => {
          const liveResult = consumeAndShift(change.lines, hunks);
          const ghostShifted = consumeAndShiftGhost(change.ghostLines, hunks);
          const newGhost = mergeSorted(ghostShifted, liveResult.consumedNewPositions);
          if (liveResult.survivors.length > 0 || newGhost.length > 0) {
            return { ...change, lines: liveResult.survivors, ghostLines: newGhost };
          }
          return null;
        }).filter(change => change !== null);
      })
  );

  return results.flat();
}

function mergeSorted(a: number[], b: number[]): number[] {
  return Array.from(new Set([...a, ...b])).sort((x, y) => x - y);
}

async function buildCommittedHistory(
  repoPath: string,
  mainCommits: CommitInfo[]
): Promise<Change[]> {
  let accumulatedChanges: Change[] = [];
  let startIndex = 0;

  for (let index = mainCommits.length - 1; index >= 0; index--) {
    const cached = commitHistoryCache.get(mainCommits[index].hash);
    if (cached) {
      // Deep clone to prevent accidental cache mutations
      accumulatedChanges = cached.map(cache => ({ ...cache, lines: [...cache.lines], ghostLines: [...(cache.ghostLines ?? [])] }));
      startIndex = index + 1;

      break;
    }
  }

  // 2. Compute only what is missing sequentially
  for (let index = startIndex; index < mainCommits.length; index++) {
    const mainCommit = mainCommits[index];
    const prevTree = index > 0
      ? mainCommits[index - 1].treeHash
      : mainCommit.treeHash;

    if (accumulatedChanges.length > 0 && prevTree !== mainCommit.treeHash) {
      accumulatedChanges = await propagateChanges(repoPath, accumulatedChanges, prevTree, mainCommit.treeHash);
    }

    const tracyId = await getTracyIdNote(repoPath, mainCommit.hash);
    if (tracyId) {
      const tracyStartCommit = await getTracyRefCommit(repoPath, tracyId);

      if (tracyStartCommit) {
        const tracyChain = await getTracyChain(repoPath, tracyStartCommit);

        const newChanges = await extractChangesFromSnapshotChain(
          repoPath,
          tracyChain,
          prevTree,
          mainCommit.treeHash,
          mainCommit
        );

        accumulatedChanges.push(...newChanges);
      }
    }

    if (accumulatedChanges.length > 0) {
      commitHistoryCache.set(mainCommit.hash, accumulatedChanges);
    }
  }

  return accumulatedChanges;
}

async function buildUncommittedChanges(
  repoPath: string,
  headTree: string
): Promise<{ uncommittedChanges: Change[]; lastTracyTip: string }> {
  const activeTracyId = await getActiveTracyId(repoPath);
  if (!activeTracyId) {
    return { uncommittedChanges: [], lastTracyTip: headTree };
  }

  const activeHiddenTip = await getTracyLocalRefCommit(repoPath, activeTracyId);

  if (!activeHiddenTip) {
    return { uncommittedChanges: [], lastTracyTip: headTree };
  }

  const tracyChain = await getTracyChain(repoPath, activeHiddenTip);
  if (tracyChain.length === 0) {
    return { uncommittedChanges: [], lastTracyTip: headTree };
  }

  const lastTracyTip = tracyChain[tracyChain.length - 1].treeHash;
  const chainChanges = await Promise.all(
    tracyChain.map((snapshot, index) =>
      extractSnapshot(
        repoPath,
        snapshot,
        tracyChain,
        headTree,
        index,
        lastTracyTip
      )
    )
  );

  return { uncommittedChanges: chainChanges.flat(), lastTracyTip };
}

// Bounds the BLEU fallback pass below to a fixed-size window per old line
// rather than searching every remaining candidate. Gating on the total
// unmatched-old x unmatched-new product (an earlier version of this cap)
// meant that once a hunk had enough purely-unmatched lines — e.g. a
// uniform field rename applied throughout, ~450 lines on each side, none
// of which exact-match — the ENTIRE fallback got skipped, dropping
// attribution for a whole hunk that's exactly the case this fallback
// exists for. A per-line window keeps cost bounded (linear in hunk size)
// without that all-or-nothing cliff: every unmatched old line still gets
// a real, bounded search.
const FUZZY_MATCH_WINDOW = 500;
// Once a match's score has gone unbeaten for this many consecutive
// offsets (and already clears the significance threshold), stop
// searching — the common case (an in-place rename, no reordering) finds
// its match at or near offset 0 and gains nothing from scanning the rest
// of the window.
const FUZZY_MATCH_EARLY_EXIT_PATIENCE = 20;

// Aligns a hunk's old lines to its new lines one-to-one and in order,
// instead of matching each tracked line independently — independent
// per-line lookups all resolve a duplicated line (`}`, `return;`,
// identical log lines, common in an "insignificant" hunk) to the SAME
// first occurrence, colliding distinct duplicates onto one new position
// and losing attribution for the rest, or letting a later match overwrite
// an earlier one that legitimately owns a different occurrence.
//
// Exact (whitespace-insensitive) matches are found via an O(n+m) hash
// lookup — grouping new-line indices by content and consuming each
// group in order as old lines are walked — which respects both order and
// duplicate multiplicity (two `}` lines in the old text land on two
// different `}` lines in the new text, not both on the first one) without
// the O(n*m) time and space a full LCS table would cost. A large hunk
// (reformatting or bulk-renaming an equally large file) can easily reach
// thousands of lines, where an O(n*m) table would mean hundreds of MB to
// GBs of allocation. Whatever's left over falls back to the best
// remaining BLEU-similar candidate, bounded by FUZZY_MATCH_SEARCH_CAP.
function alignHunkLines(hunk: DiffHunk): Map<number, number> {
  const oldLines = hunk.removedLines ?? [];
  const addedLines = hunk.addedLines ?? [];
  const normalize = (s: string) => s.replace(/\s+/g, '');

  const newIndicesByContent = new Map<string, number[]>();
  addedLines.forEach((text, newIndex) => {
    const key = normalize(text);
    const bucket = newIndicesByContent.get(key);
    if (bucket) {
      bucket.push(newIndex);
    } else {
      newIndicesByContent.set(key, [newIndex]);
    }
  });

  // Consumed via a per-bucket cursor rather than bucket.shift(): shift()
  // shifts every remaining element down by one, so repeatedly shifting the
  // SAME bucket (a hunk with many identical lines — `}`, blank lines,
  // templated log statements — is exactly when this bucket gets consumed
  // over and over) is O(k) per call, O(k^2) total for that bucket alone.
  // A cursor makes each consumption O(1) regardless of bucket size.
  const bucketCursors = new Map<string, number>();
  const alignment = new Map<number, number>();
  const usedNewIndices = new Set<number>();
  const unmatchedOldIndices: number[] = [];
  oldLines.forEach((text, oldIndex) => {
    const key = normalize(text);
    const bucket = newIndicesByContent.get(key);
    const cursor = bucketCursors.get(key) ?? 0;
    if (bucket && cursor < bucket.length) {
      const newIndex = bucket[cursor];
      bucketCursors.set(key, cursor + 1);
      alignment.set(oldIndex, newIndex);
      usedNewIndices.add(newIndex);
    } else {
      unmatchedOldIndices.push(oldIndex);
    }
  });

  const unmatchedNewIndices: number[] = [];
  for (let newIndex = 0; newIndex < addedLines.length; newIndex++) {
    if (!usedNewIndices.has(newIndex)) {
      unmatchedNewIndices.push(newIndex);
    }
  }

  if (unmatchedOldIndices.length > 0 && unmatchedNewIndices.length > 0) {
    const remainingNewIndices = new Set(unmatchedNewIndices);
    const oldCount = oldLines.length;
    const newCount = addedLines.length;

    // Anchors: the exact matches already found above, used to LOCALLY
    // estimate an unmatched line's expected position instead of scaling
    // it against the hunk as a whole. A single global scale is wrong by
    // however many lines were inserted/deleted before this point in the
    // hunk — e.g. ~50 lines inserted right before a large renamed block
    // shifts every renamed line's true position by ~50, but a global
    // estimate only accounts for a fraction of that, landing the search
    // window's center nowhere near the real match deep inside the block.
    // Anchored to the exact matches immediately surrounding each gap
    // instead — which, being exact, already reflect the true offset at
    // that point exactly — the very first candidate checked is already
    // close to correct. unmatchedOldIndices is walked in ascending order,
    // so a single forward-moving pointer through the sorted anchors is
    // enough; no need to re-search from the start each time.
    const anchorOldIndices = Array.from(alignment.keys()).sort((a, b) => a - b);
    let anchorPointer = 0;

    for (const oldIndex of unmatchedOldIndices) {
      while (anchorPointer < anchorOldIndices.length && anchorOldIndices[anchorPointer] < oldIndex) {
        anchorPointer++;
      }
      const prevAnchorOld = anchorPointer > 0 ? anchorOldIndices[anchorPointer - 1] : -1;
      const prevAnchorNew = anchorPointer > 0 ? alignment.get(prevAnchorOld)! : -1;
      const nextAnchorOld = anchorPointer < anchorOldIndices.length ? anchorOldIndices[anchorPointer] : oldCount;
      const nextAnchorNew = anchorPointer < anchorOldIndices.length ? alignment.get(nextAnchorOld)! : newCount;

      const span = nextAnchorOld - prevAnchorOld;
      const estimatedNewIndex = span > 0
        ? Math.round(prevAnchorNew + ((oldIndex - prevAnchorOld) * (nextAnchorNew - prevAnchorNew)) / span)
        : prevAnchorNew + 1;

      // How many net lines were inserted (positive) or deleted (negative)
      // within this specific anchor-bounded gap (the whole hunk, when
      // there are no anchors at all — exactly the "big rename hunk,
      // nothing exact-matches" case). The estimate above assumes that
      // shift is spread proportionally across the gap; if it's actually
      // concentrated at one end (e.g. a block of lines inserted right
      // before a renamed section), an old line near that end can have
      // templated/near-duplicate content elsewhere in the gap score just
      // as well as its real match, which — without a bound tied to the
      // shift itself — patience-based exit could settle on before the
      // search ever reaches the real one.
      const signedLocalDrift = (nextAnchorNew - prevAnchorNew) - (nextAnchorOld - prevAnchorOld);
      const patience = Math.min(FUZZY_MATCH_WINDOW, Math.max(FUZZY_MATCH_EARLY_EXIT_PATIENCE, Math.abs(signedLocalDrift)));

      // Stop early once a confidently-good match has been sitting
      // unbeaten for a while — without this, every line would always
      // scan the full window even after finding an obviously-correct
      // match at offset 0 (the common case for an in-place rename that
      // doesn't reorder anything), which is what actually made this loop
      // slow in practice, not the window bound itself. Patience scales
      // with the drift so a search can't settle before at least reaching
      // the position the gap's own line-count change implies.
      let bestIndex = -1;
      let bestScore = -1;
      let bestTieDistance = Infinity;
      let noImprovementStreak = 0;
      for (let offset = 0; offset <= FUZZY_MATCH_WINDOW; offset++) {
        const candidates = offset === 0
          ? [{ index: estimatedNewIndex, signedOffset: 0 }]
          : [
              { index: estimatedNewIndex - offset, signedOffset: -offset },
              { index: estimatedNewIndex + offset, signedOffset: offset },
            ];

        // A strict improvement both updates the pick AND counts as
        // progress (resets the patience counter below). An exact tie only
        // updates the pick if it's closer to signedLocalDrift than the
        // current pick — i.e. closer to the offset the gap's own
        // insertion/deletion actually implies. When nothing shifted
        // (signedLocalDrift = 0, an in-place rename with no size change),
        // that means preferring whichever tie sits closest to the
        // estimate itself, not whichever was found first OR farthest —
        // without this, a hunk of many identical, uniformly-renamed lines
        // would drift every line's pick toward the edge of the search
        // window for no reason, since ties there don't actually reflect
        // any real shift. A tie never counts as progress either way: a
        // hunk where many old lines each have many identically-scoring
        // candidates (e.g. that same uniform rename) would otherwise have
        // every tie reset the counter, defeating the patience-based exit
        // and forcing a full-window scan for every line.
        let improved = false;
        for (const { index: candidate, signedOffset } of candidates) {
          if (candidate < 0 || candidate >= newCount || !remainingNewIndices.has(candidate)) {
            continue;
          }
          const score = bleuSimilarity(oldLines[oldIndex], addedLines[candidate]);
          const tieDistance = Math.abs(signedOffset - signedLocalDrift);
          if (score > bestScore) {
            bestScore = score;
            bestIndex = candidate;
            bestTieDistance = tieDistance;
            improved = true;
          } else if (score === bestScore && tieDistance < bestTieDistance) {
            bestIndex = candidate;
            bestTieDistance = tieDistance;
          }
        }

        noImprovementStreak = improved ? 0 : noImprovementStreak + 1;
        if (bestScore > SIMILARITY_THRESHOLD && noImprovementStreak >= patience) {
          break;
        }
      }

      if (bestIndex !== -1 && bestScore > SIMILARITY_THRESHOLD) {
        alignment.set(oldIndex, bestIndex);
        remainingNewIndices.delete(bestIndex);
      }
    }
  }

  return alignment;
}

// Drops lines that fall inside a significant modified or deleted hunk.
// Insignificant hunks preserve AI attribution only for the specific new
// line this old line's content aligns to (see alignHunkLines) — not every
// new line in the hunk.
// Pure insertions (oldCount = 0) never consume old lines, only shift subsequent ones
// Also returns the new-tree positions of lines consumed by significant hunks so the
// caller can record them as "ghost" attribution for the previous owner.
function consumeAndShift(lines: number[], hunks: DiffHunk[]): { survivors: number[]; consumedNewPositions: number[] } {
  const survivingLines = new Set<number>();
  const consumedHunks = new Set<DiffHunk>();
  // Memoized per hunk within this call: alignHunkLines is a pure function
  // of the hunk's own content, so every tracked line landing in the same
  // hunk (whether from this tasklet's own lines, or a separate
  // consumeAndShift call for a different tasklet touching the same hunk)
  // resolves against the same one-to-one mapping — duplicate lines land on
  // distinct occurrences instead of colliding on the first match.
  const hunkAlignments = new Map<DiffHunk, Map<number, number>>();

  const sortedLines = [...lines].sort((a, b) => a - b);
  const sortedHunks = [...hunks].sort((a, b) => a.oldStart - b.oldStart);

  for (const line of sortedLines) {
    // Find if line falls inside any hunk
    let containingHunk: DiffHunk | null = null;
    for (const hunk of sortedHunks) {
      if (hunk.oldCount > 0 && line >= hunk.oldStart && line < hunk.oldStart + hunk.oldCount) {
        containingHunk = hunk;
        break;
      }
    }

    if (containingHunk) {
      if (containingHunk.isSignificant) {
        // Significant hunk: consume the line (user override). Ghost-tracked
        // across the whole replaced block below, since a real rewrite has
        // no specific "successor line" to point to.
        consumedHunks.add(containingHunk);
        continue;
      }

      // Insignificant hunk: only credit the specific new line this old
      // line aligns to. If nothing in the hunk resembles it anymore, drop
      // it rather than guessing — deliberately not ghost-tracked either,
      // to avoid the same blanket-crediting problem this function exists
      // to avoid.
      if (!hunkAlignments.has(containingHunk)) {
        hunkAlignments.set(containingHunk, alignHunkLines(containingHunk));
      }
      const newIndex = hunkAlignments.get(containingHunk)!.get(line - containingHunk.oldStart);

      if (newIndex !== undefined) {
        survivingLines.add(containingHunk.newStart + newIndex);
      }
    } else {
      // Line not in any hunk, apply shifts from all hunks before this line
      let totalShift = 0;
      for (const hunk of sortedHunks) {
        const effectiveOldStart = hunk.oldCount === 0 ? hunk.oldStart + 1 : hunk.oldStart;
        if (line < effectiveOldStart) { break; }
        totalShift += (hunk.newCount - hunk.oldCount);
      }
      survivingLines.add(line + totalShift);
    }
  }

  const consumedNewPositions = new Set<number>();
  for (const hunk of consumedHunks) {
    for (let i = 0; i < hunk.newCount; i++) {
      consumedNewPositions.add(hunk.newStart + i);
    }
  }

  return {
    survivors: Array.from(survivingLines).sort((a, b) => a - b),
    consumedNewPositions: Array.from(consumedNewPositions).sort((a, b) => a - b),
  };
}

// Ghost lines flow through a diff like live lines, but lines consumed by a
// significant hunk are NOT dropped — they relocate to the new-tree positions
// so the historical attribution chain stays linked through subsequent edits.
function consumeAndShiftGhost(lines: number[], hunks: DiffHunk[]): number[] {
  if (lines.length === 0) { return []; }
  const { survivors, consumedNewPositions } = consumeAndShift(lines, hunks);
  return mergeSorted(survivors, consumedNewPositions);
}

// For each AI change, drop lines that fall inside a user-modified hunk
// and shift lines that were only moved by user insertions/deletions
async function consumeUserChanges(
  repoPath: string,
  changes: Change[],
  lastTracyTip: string
): Promise<Change[]> {
  const byFile = new Map<string, Change[]>();
  for (const change of changes) {
    if (!byFile.has(change.filePath)) {
      byFile.set(change.filePath, []);
    }

    byFile.get(change.filePath)!.push(change);
  }

  const results = await Promise.all(
    Array.from(byFile.entries()).map(async ([filePath, fileChanges]) => {
      const userHunkMap = await getDiff(repoPath, lastTracyTip, "WORKING_DIR", filePath);
      const userHunks = userHunkMap.get(filePath) || [];

      if (userHunks.length === 0) {
        return fileChanges;
      }

      return fileChanges
        .map(change => {
          const liveResult = consumeAndShift(change.lines, userHunks);
          const ghostShifted = consumeAndShiftGhost(change.ghostLines, userHunks);
          const newGhost = mergeSorted(ghostShifted, liveResult.consumedNewPositions);
          if (liveResult.survivors.length > 0 || newGhost.length > 0) {
            return { ...change, lines: liveResult.survivors, ghostLines: newGhost };
          }
          return null;
        })
        .filter((change) => change !== null);
    })
  );

  return results.flat();
}

// Strip from each change any line that a later change also claims
// Changes must be in oldest-first order and uncommitted changes trail after committed ones
function deduplicateAILines(changes: Change[]): Change[] {
  const byFile = new Map<string, Change[]>();
  for (const change of changes) {
    if (!byFile.has(change.filePath)) {
      byFile.set(change.filePath, []);
    }

    byFile.get(change.filePath)!.push(change);
  }

  const result: Change[] = [];
  // TODO: This is awfully slow -> O(n^4)
  for (const fileChanges of byFile.values()) {
    for (let i = 0; i < fileChanges.length; i++) {
      const laterLines = new Set<number>();

      for (let j = i + 1; j < fileChanges.length; j++) {
        for (const line of fileChanges[j].lines) {
          laterLines.add(line);
        }
      }

      const filtered = fileChanges[i].lines.filter(l => !laterLines.has(l));
      const overridden = fileChanges[i].lines.filter(l => laterLines.has(l));
      const ghost = mergeSorted(fileChanges[i].ghostLines, overridden);
      if (filtered.length > 0 || ghost.length > 0) {
        result.push({ ...fileChanges[i], lines: filtered, ghostLines: ghost });
      }
    }
  }

  return result;
}

export async function buildHistory(repoPath: string | undefined): Promise<BuildHistoryResult> {
  if (!repoPath) {
    return { ok: false, reason: 'no-repo-path' };
  }

  try {
    await runGit(repoPath, ["rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    console.error("Not a valid git repository:", error);
    return { ok: false, reason: 'not-a-git-repo' };
  }

  try {
    let mainCommits: CommitInfo[];
    try {
      mainCommits = await getMainCommits(repoPath);
    } catch (error) {
      // `git log` itself fails (exit 128, "does not have any commits yet")
      // on a freshly-initialized repo — mainCommits.length === 0 below never
      // actually fires for that case, getMainCommits throws first. Any other
      // reason `git log` could fail here (the is-inside-work-tree check
      // above already passed) is rare enough that folding it into
      // "no commits" is an acceptable, much simpler trade-off than parsing
      // git's stderr text.
      console.error("Failed to read commit history (treating as no commits):", error);
      return { ok: false, reason: 'no-commits' };
    }
    if (mainCommits.length === 0) {
      return { ok: false, reason: 'no-commits' };
    }

    const headCommitHash = await runGit(repoPath, ["rev-parse", "HEAD"]);
    const headTree = await getCommitTree(repoPath, headCommitHash);

    if (!headTree) {
      return { ok: false, reason: 'no-head-tree' };
    }

    // Build committed AI changes first
    const committedChanges = await buildCommittedHistory(repoPath, mainCommits);
    // Build uncommitted AI changes
    const { uncommittedChanges, lastTracyTip } = await buildUncommittedChanges(repoPath, headTree);
    // Align committed changes to lastTracyTip
    let alignedCommitted = committedChanges;
    if (lastTracyTip !== headTree) {
      alignedCommitted = await propagateChanges(repoPath, committedChanges, headTree, lastTracyTip);
    }

    // Consume user changes since the last snapshot
    const userConsumed = await consumeUserChanges(
      repoPath,
      [...alignedCommitted, ...uncommittedChanges],
      lastTracyTip
    );

    return {
      ok: true,
      history: {
        id: headCommitHash || "WORKING_DIR",
        files: groupChangesByFile(deduplicateAILines(userConsumed)),
      },
    };
  } catch (error) {
    console.error("Error building history:", error);
    return { ok: false, reason: 'build-error' };
  }
}

export function describeBuildHistoryFailure(reason: BuildHistoryFailureReason): string {
  switch (reason) {
    case 'not-a-git-repo':
      return 'AI Blame: This needs to be a git repository.';
    case 'no-commits':
      return 'AI Blame: This repository has no commits yet.';
    case 'no-repo-path':
      return 'AI Blame: No repository found for the current workspace.';
    case 'no-head-tree':
    case 'build-error':
    default:
      return 'AI Blame: Failed to build history.';
  }
}
