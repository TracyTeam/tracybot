import { Change, CommitInfo, History, TaskletMessage } from "./types";
import {
  getActiveHiddenCommit,
  getActiveTracyId,
  getChangedLines,
  getCommitTree,
  getDiff,
  getTracyRefCommit,
  groupChangesByFile,
  isAiChange,
  mapLinesToTree,
  runGit
} from "../utils";

const DELIMITER = "||#--TRACY--#||";

// Get all visible (non-hidden) commits from the user branch
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

function buildTaskletMessages(tasklet_str: string): TaskletMessage[] {
  let tasklet_obj: any;
  try {
    tasklet_obj = JSON.parse(tasklet_str);
  } catch (e) {
    console.error(`Could not parse tasklet: ${tasklet_str}`);
    return [];
  }

  if (!tasklet_obj) {
    console.error(`Could not parse tasklet: ${tasklet_str}`);
    return [];
  }

  let messages: TaskletMessage[] = [];
  if (tasklet_obj?.planOutputs && Array.isArray(tasklet_obj.planOutputs)) {
    tasklet_obj.planOutputs.forEach((plan: any) => {
      if (plan.prompt) {
        messages.push({ stage: "plan", type: "prompt", message: plan.prompt });
      }
      if (plan.response) {
        messages.push({ stage: "plan", type: "response", message: plan.response });
      }
    });
  }

  if (!tasklet_obj.buildOutput) {
    console.warn(`Missing build output in tasklet: ${tasklet_str}`);
  } else {
    messages.push({ stage: "build", type: "prompt", message: tasklet_obj.buildOutput?.prompt });
    messages.push({ stage: "build", type: "response", message: tasklet_obj.buildOutput?.response });
  }

  return messages;
}

async function extractChangesFromSnapshotChain(
  repoPath: string,
  chain: CommitInfo[],
  baseTree: string,
  targetTree: string | "WORKING_DIR",
  finalTree: string | "WORKING_DIR"
): Promise<Change[]> {
  const results = await Promise.all(
    chain.map(async (snapshot, index) => {
      return extractSnapshot(repoPath, snapshot, chain, baseTree, index, targetTree, finalTree);
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
  finalTree: string | "WORKING_DIR"
): Promise<Change[]> {
  if (!isAiChange(snapshot)) {
    return [];
  }

  const messages: Array<TaskletMessage> = buildTaskletMessages(snapshot.description);
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

      let lines: number[] = [];

      if (targetTree === "WORKING_DIR") {
        lines = await mapLinesToTree(
          repoPath,
          snapshot.treeHash,
          "WORKING_DIR",
          filePath,
          linesAtSnapshot
        );
      } else {
        // Map the snapshot to the real commit
        // Unstaged lines will be treated as deleted and dropped
        const linesInMainCommit = await mapLinesToTree(
          repoPath,
          snapshot.treeHash,
          targetTree,
          filePath,
          linesAtSnapshot
        );

        // Map the surviving lines from the real commit to the finalTree
        lines = await mapLinesToTree(
          repoPath,
          targetTree,
          finalTree,
          filePath,
          linesInMainCommit
        );
      }

      if (lines.length > 0) {
        return {
          filePath,
          lines,
          model: snapshot.authorName,
          tasklet_messages: messages,
          snapshotHash: snapshot.hash,
        } as Change;
      }

      return null;
    })
  );

  return fileResults.filter((result) => result !== null);
}

async function buildCommittedHistory(
  repoPath: string,
  mainCommits: CommitInfo[],
  lastTracyTip: string
): Promise<Change[]> {
  const result = await Promise.all(
    mainCommits.map(async (mainCommit, i) => {
      const tracyId = await getTracyIdNote(repoPath, mainCommit.hash);
      if (!tracyId) {
        return [];
      }

      const tracyStartCommit = await getTracyRefCommit(repoPath, tracyId);
      if (!tracyStartCommit) {
        return [];
      }

      const tracyChain: CommitInfo[] = await getTracyChain(repoPath, tracyStartCommit);
      const prevMainTree = i > 0 ? mainCommits[i - 1].treeHash : mainCommit.treeHash;

      return extractChangesFromSnapshotChain(
        repoPath,
        tracyChain,
        prevMainTree,
        mainCommit.treeHash,
        lastTracyTip  // map all the way to last AI state
      );
    })
  );

  return result.flat();
}

async function buildUncommittedChanges(
  repoPath: string,
  headTree: string
): Promise<{ uncommittedChanges: Change[]; lastTracyTip: string }> {
  const activeTracyId = await getActiveTracyId(repoPath);
  if (!activeTracyId) {
    return { uncommittedChanges: [], lastTracyTip: headTree };
  }

  const activeHiddenTip = await getActiveHiddenCommit(repoPath, activeTracyId);
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
        lastTracyTip,
        lastTracyTip
      )
    )
  );

  return { uncommittedChanges: chainChanges.flat(), lastTracyTip };
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
          const survivingLines: number[] = [];

          for (const line of [...change.lines].sort((a, b) => a - b)) {
            let currentShift = 0;
            let mapped = false;

            for (const hunk of userHunks) {
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

// TODO: CACHE THIS FOR THE LOVE OF GOD!!!
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

    // Build uncommitted AI changes first
    const { uncommittedChanges, lastTracyTip } = await buildUncommittedChanges(repoPath, headTree);
    // Build committed AI changes
    const committedChanges = await buildCommittedHistory(repoPath, mainCommits, lastTracyTip);
    // Consume user changes since the last snapshot
    const userConsumed = await consumeUserChanges(
      repoPath,
      [...committedChanges, ...uncommittedChanges],
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
