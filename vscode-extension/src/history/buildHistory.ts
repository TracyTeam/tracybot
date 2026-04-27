import { Change, CommitInfo, DiffHunk, History, TaskletMessage } from "./types";
import {
  getActiveHiddenCommit,
  getActiveTracyId,
  getChangedLines,
  getCommitTree,
  getDiff,
  getTracyLocalRefCommit,
  getTracyRefCommit,
  groupChangesByFile,
  isAiChange,
  mapLinesToTree,
  runGit
} from "../utils";

const DELIMITER = "||#--TRACY--#||";

// Key: git commit hash
let commitHistoryCache: Map<string, Change[]> = new Map();

export function hydrateCache(serialized: Record<string, Change[]> | undefined) {
  if (!serialized) {
    return;
  }

  commitHistoryCache = new Map(Object.entries(serialized));
}

export function getSerializedCache(): Record<string, Change[]> {
  return Object.fromEntries(commitHistoryCache);
}

async function getMainCommits(repoPath: string): Promise<CommitInfo[]> {
  // Commit info in format: hash|email|name|subject|body|parent|tree
  const output = await runGit(repoPath, [
    "log",
    "--reverse",
    `--format=%H${DELIMITER}%ae${DELIMITER}%an${DELIMITER}%s${DELIMITER}%b${DELIMITER}%P${DELIMITER}%T`,
  ]);

  if (!output) {
    return [];
  }

  const commits: CommitInfo[] = [];
  for (const line of output.split("\n")) {
    if (!line) {
      continue;
    }

    const [hash, authorEmail, authorName, message, description, parentHash, treeHash] = line.split(DELIMITER);
    commits.push({
      hash,
      authorEmail,
      authorName,
      message,
      description,
      parentHash: parentHash || null,
      treeHash
    });
  }

  return commits;
}

async function getTracyIdNote(repoPath: string, commitHash: string): Promise<string | null> {
  try {
    const output = await runGit(repoPath, ["notes", "show", commitHash]);
    const match = output.match(/tracy-id:\s*([a-f0-9-]+)/);

    return match ? match[1] : null;
  } catch {
    return null;
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
      // Commit info in format: hash|email|name|subject|body|parent|tree
      const output = await runGit(repoPath, [
        "log",
        "-1",
        `--format=%H${DELIMITER}%ae${DELIMITER}%an${DELIMITER}%s${DELIMITER}%b${DELIMITER}%P${DELIMITER}%T`,
        currentHash
      ]);

      if (!output) {
        continue;
      }

      const [hash, authorEmail, authorName, message, description, parentHash, treeHash] = output.split(DELIMITER);
      commits.push({
        hash,
        authorEmail,
        authorName,
        message,
        description,
        parentHash: parentHash || null,
        treeHash: treeHash
      });

      // Check for multiple parents (merge commit)
      // Merge commits have parents separated by space: "parent1 parent2 parent3"
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

function buildTaskletMessages(tasklet_str: string): { messages: TaskletMessage[], title: string } {
  let tasklet_obj: any;
  let messages: TaskletMessage[] = [];
  let title = "skill issue";

  try {
    tasklet_obj = JSON.parse(tasklet_str);
  } catch (e) {
    console.error(`Could not parse tasklet: ${tasklet_str}`);
    return { messages, title };
  }

  if (!tasklet_obj) {
    console.error(`Could not parse tasklet: ${tasklet_str}`);
    return { messages, title };
  }

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
        messages.push({ stage: "plan", type: "prompt", message: plan.prompt });
      }

      if (plan.response) {
        messages.push({ stage: "plan", type: "response", message: appendQuestions(plan.response, plan.id) });
      }
    });
  }

  if (!tasklet_obj.buildOutput) {
    console.warn(`Missing build output in tasklet: ${tasklet_str}`);
  } else {
    messages.push({ stage: "build", type: "prompt", message: tasklet_obj.buildOutput?.prompt });
    messages.push({ stage: "build", type: "response", message: appendQuestions(tasklet_obj.buildOutput?.response ?? "", tasklet_obj.buildOutput?.id) });
  }

  return { messages, title };
}

async function extractChangesFromSnapshotChain(
  repoPath: string,
  chain: CommitInfo[],
  baseTree: string,
  targetTree: string | "WORKING_DIR"
): Promise<Change[]> {
  const results = await Promise.all(
    chain.map(async (snapshot, index) => {
      return extractSnapshot(repoPath, snapshot, chain, baseTree, index, targetTree);
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
  targetTree: string | "WORKING_DIR"
): Promise<Change[]> {
  if (!isAiChange(snapshot)) {
    return [];
  }

  const { messages, title } = buildTaskletMessages(snapshot.description);
  let diffFromTree = index > 0 ? chain[index - 1].treeHash : baseTree;

  if (snapshot.parentHash) {
    const parentTree = await getCommitTree(repoPath, snapshot.parentHash);

    if (parentTree) {
      diffFromTree = parentTree;
    }
  }

  const fileChangesMap = await getDiff(repoPath, diffFromTree, snapshot.treeHash);
  const fileResults = await Promise.all(
  Array.from(fileChangesMap.keys()).map(async (filePath) => {
    const linesAtSnapshot = await getChangedLines(
      repoPath,
      diffFromTree,
      snapshot.treeHash,
      filePath
    );

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
          hunk.oldCount > 0 && // ignore pure insertions
          line >= hunk.oldStart &&
          line < hunk.oldStart + hunk.oldCount
        );
      });
    });

    if (filteredLines.length > 0) {
      return {
        filePath,
        lines: filteredLines,
        model: snapshot.authorName,
        name: title,
        tasklet_messages: messages,
        snapshotHash: snapshot.hash,
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
          const surviving = consumeAndShift(change.lines, hunks);
          return surviving.length > 0
            ? { ...change, lines: surviving }
            : null;
        }).filter(change => change !== null);
      })
  );

  return results.flat();
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
      accumulatedChanges = cached.map(cache => ({ ...cache, lines: [...cache.lines] }));
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
          mainCommit.treeHash
        );

        accumulatedChanges.push(...newChanges);
      }
    }

    commitHistoryCache.set(mainCommit.hash, accumulatedChanges);
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

  let activeHiddenTip = await getTracyLocalRefCommit(repoPath, activeTracyId);
  
  if (!activeHiddenTip) {
    activeHiddenTip = await getActiveHiddenCommit(repoPath, activeTracyId);
  }
  
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

// Drops lines that fall inside a modified or deleted hunk, shifts lines that are before one
// Pure insertions (oldCount = 0) never consume old lines, only shift subsequent ones
function consumeAndShift(lines: number[], hunks: DiffHunk[]): number[] {
  const survivingLines: number[] = [];

  for (const line of [...lines].sort((a, b) => a - b)) {
    let currentShift = 0;
    let mapped = false;

    for (const hunk of hunks) {
      // Pure insertions (oldCount === 0) have no old-space range to consume
      // Their effective start for ordering purposes is oldStart + 1
      const effectiveOldStart = hunk.oldCount === 0 ? hunk.oldStart + 1 : hunk.oldStart;

      if (line < effectiveOldStart) {
        survivingLines.push(line + currentShift);
        mapped = true;

        break;
      }

      // Line falls inside a user modified or user deleted region
      if (hunk.oldCount > 0 && line >= hunk.oldStart && line < hunk.oldStart + hunk.oldCount) {
        mapped = true;

        break;
      }

      currentShift += (hunk.newCount - hunk.oldCount);
    }

    if (!mapped) {
      survivingLines.push(line + currentShift);
    }
  }

  return survivingLines;
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
          const survivingLines = consumeAndShift(change.lines, userHunks);
          return survivingLines.length > 0
            ? { ...change, lines: survivingLines }
            : null;
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
      if (filtered.length > 0) {
        result.push({ ...fileChanges[i], lines: filtered });
      }
    }
  }

  return result;
}

export async function buildHistory(repoPath: string | undefined): Promise<History | null> {
  if (!repoPath) {
    return null;
  }

  try {
    await runGit(repoPath, ["rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    console.error("Not a valid git repository:", error);

    return null;
  }

  try {
    const mainCommits = await getMainCommits(repoPath);
    if (mainCommits.length === 0) {
      return null;
    }

    const headCommitHash = await runGit(repoPath, ["rev-parse", "HEAD"]);
    const headTree = await getCommitTree(repoPath, headCommitHash);

    if (!headTree) {
      return null;
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
      id: headCommitHash || "WORKING_DIR",
      files: groupChangesByFile(deduplicateAILines(userConsumed)),
    };
  } catch (error) {
    console.error("Error building history:", error);
    return null;
  }
}
