import { Change, CommitInfo, History, TaskletMessage } from "./types";
import { getChangedLines, getCommitTree, getDiff, getTracyRefCommit, groupChangesByFile, runGit } from "./helpers";
import { error } from "console";

// Get all visible (non-hidden) commits from the user branch
async function getMainCommits(repoPath: string): Promise<CommitInfo[]> {
  // Commit info in format: hash|email|name|subject|body|parent|tree
  const output = await runGit(repoPath, [
    "log",
    "--reverse",
    "--format=%H|%ae|%an|%s|%b|%P|%T",
  ]);

  if (!output) {
    return [];
  }

  const commits: CommitInfo[] = [];
  for (const line of output.split("\n")) {
    if (!line) {
      continue;
    }

    const [hash, authorEmail, authorName, message, description, parentHash, treeHash] = line.split("|");
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
        "--format=%H|%ae|%an|%s|%b|%P|%T",
        currentHash
      ]);

      if (!output) {
        continue;
      }

      const [hash, authorEmail, authorName, message, description, parentHash, treeHash] = output.split("|");
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

  return commits;
}

function isAiChange(commit: CommitInfo): boolean {
  return commit.authorEmail.toLowerCase() === "opencode";
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

// AAAAAAAAAAAAAAA
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

    const changes: Change[] = [];
    for (let i = 0; i < mainCommits.length; i++) {
      const mainCommit = mainCommits[i];

      const tracyId = await getTracyIdNote(repoPath, mainCommit.hash);
      if (tracyId) {
        const tracyStartCommit = await getTracyRefCommit(repoPath, tracyId);
        if (!tracyStartCommit) {
          continue;
        }

        const tracyChain: CommitInfo[] = await getTracyChain(repoPath, tracyStartCommit);
        const prevMainTree = i > 0 ? mainCommits[i - 1].treeHash : mainCommit.treeHash;

        for (let j = 0; j < tracyChain.length; j++) {
          const snapshot: CommitInfo = tracyChain[j];
          const messages: Array<TaskletMessage> = buildTaskletMessages(snapshot.description);

          if (isAiChange(snapshot)) {
            const parentInChain = j > 0 ? tracyChain[j - 1].treeHash : prevMainTree;
            let diffFromTree = parentInChain;

            if (snapshot.parentHash) {
              const parentTree = await getCommitTree(repoPath, snapshot.parentHash);

              if (parentTree) {
                diffFromTree = parentTree;
              }
            }

            const fileChangesMap = await getDiff(repoPath, diffFromTree, snapshot.treeHash);
            for (const filePath of fileChangesMap.keys()) {
              const lines = await getChangedLines(repoPath, diffFromTree, snapshot.treeHash, filePath);

              changes.push({
                filePath,
                lines,
                model: snapshot.authorName,
                tasklet_messages: messages,
              });
            }
          }
        }
      }
    }

    return {
      id: await runGit(repoPath, ["rev-parse", "HEAD"]),
      files: groupChangesByFile(changes)
    };
  } catch (error) {
    console.error("Error building history:", error);
    return null;
  }
}
