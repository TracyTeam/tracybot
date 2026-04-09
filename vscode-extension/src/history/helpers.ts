import pLimit from 'p-limit';
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { Change, DiffHunk, History } from "./types";

const PROCESS_LIMIT = pLimit(5);

export async function runGit(repoPath: string, args: string[]): Promise<string> {
  return PROCESS_LIMIT(() => {
    return new Promise((resolve, reject) => {
      const proc = spawn("git", ["-C", repoPath, ...args]);
      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => { stdout += data.toString(); });
      proc.stderr.on("data", (data) => { stderr += data.toString(); });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Command failed: git -C ${repoPath} ${args.join(" ")}\n${stderr}`));
        }
      });

      proc.on("error", reject);
    });
  });
}

// OpenCode changed it to read ref files from the filesystem rather than git
// smth smth more efficient smth smth I agree
export async function getTracyRefCommit(repoPath: string, tracyId: string): Promise<string | null> {
  const refPath = path.join(repoPath, ".git", "refs", "tracy", tracyId);
  try {
    return fs.readFileSync(refPath, "utf-8").trim();
  } catch {
    return null;
  }
}

// Returns a map of all files that changed between two trees
// Gonna be honest, completely vibed, hunks hurt my brain
export async function getDiff(
  repoPath: string, 
  fromTree: string, 
  toTree: string, 
  filePath?: string
): Promise<Map<string, DiffHunk[]>> {
  const args = ["diff", "--no-color", "--unified=0", `${fromTree}..${toTree}`];
  if (filePath) {
    args.push("--", filePath);
  }
  
  const output = await runGit(repoPath, args);
  const fileChanges = new Map<string, DiffHunk[]>();

  if (!output) {
    return fileChanges;
  }

  let currentFile = "";
  for (const line of output.split("\n")) {
    if (line.startsWith("diff --git a/")) {
      // Example: "diff --git a/src/helpers.ts b/src/helpers.ts"
      // Group 1: Source file path (src/helpers.ts)
      // Group 2: Target file path (src/helpers.ts)
      const match = line.match(/^diff --git a\/(.*?) b\/(.*)$/);

      if (match) {
        currentFile = match[2];

        if (!fileChanges.has(currentFile)) {
          fileChanges.set(currentFile, []);
        }
      }
    } else if (line.startsWith("@@ ") && currentFile) {
      // Example: "@@ -10,4 +10,6 @@"
      // Group 1: Old file start line (10)
      // Group 2: Old file line count (4) - defaults to 1 if missing
      // Group 3: New file start line (10)
      // Group 4: New file line count (6) - defaults to 1 if missing
      const match = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?/);

      if (match) {
        fileChanges.get(currentFile)!.push({
          oldStart: parseInt(match[1], 10),
          oldCount: match[2] !== undefined ? parseInt(match[2], 10) : 1,
          newStart: parseInt(match[3], 10),
          newCount: match[4] !== undefined ? parseInt(match[4], 10) : 1,
        });
      }
    }
  }

  return fileChanges;
}

export async function getChangedLines(repoPath: string, fromTree: string, toTree: string, filePath: string): Promise<number[]> {
  const fileHunks = await getDiff(repoPath, fromTree, toTree, filePath);
  const hunks = fileHunks.get(filePath) || [];
  const lines: number[] = [];

  for (const hunk of hunks) {
    for (let i = 0; i < hunk.newCount; i++) {
      lines.push(hunk.newStart + i);
    }
  }

  return lines;
}

// Map line numbers from an old tree to their 
// corresponding line numbers on a new tree
export async function mapLinesToTree(
  repoPath: string,
  fromTree: string,
  toTree: string,
  filePath: string,
  lines: number[]
): Promise<number[]> {
  if (lines.length === 0) {
    return [];
  }

  const fileHunks = await getDiff(repoPath, fromTree, toTree, filePath);
  const hunks = fileHunks.get(filePath) || [];

  if (hunks.length === 0) {
    return lines;
  }

  const finalLines = new Set<number>();

  for (const line of lines) {
    let mapped = false;
    let currentShift = 0;

    for (const hunk of hunks) {
      // In unified=0 diffs, a pure insertion has oldCount = 0.
      // The oldStart is the line BEFORE the insertion.
      const effectiveOldStart = hunk.oldCount === 0 ? hunk.oldStart + 1 : hunk.oldStart;

      // If the line comes before this hunk, apply accumulated shifts and break early
      if (line < effectiveOldStart) {
        finalLines.add(line + currentShift);
        mapped = true;

        break;
      }

      // If the line falls inside the hunk, it was modified or deleted
      if (line >= hunk.oldStart && line < hunk.oldStart + hunk.oldCount) {
        for (let i = 0; i < hunk.newCount; i++) {
          finalLines.add(hunk.newStart + i);
        }

        mapped = true;
        
        break;
      }

      // Accumulate the line shift for subsequent lines
      currentShift += (hunk.newCount - hunk.oldCount);
    }

    // If the line was past all hunks, apply the total shift
    if (!mapped) {
      finalLines.add(line + currentShift);
    }
  }

  return Array.from(finalLines).sort((a, b) => a - b);
}

// The tree hash represents the state of the entire repository at that commit
export async function getCommitTree(repoPath: string, commitHash: string): Promise<string | null> {
  try {
    return await runGit(repoPath, ["log", "-1", "--format=%T", commitHash]) || null;
  } catch {
    return null;
  }
}

export function groupChangesByFile(changes: Change[]): History["files"] {
  const fileMap = new Map<string, Change[]>();

  for (const change of changes) {
    const existing = fileMap.get(change.filePath) || [];
    existing.push(change);

    fileMap.set(change.filePath, existing);
  }

  // TODO: maybe change the schema to not have this array conversion?
  const files: History["files"] = [];
  for (const [path, fileChanges] of fileMap) {
    files.push({
      path,
      tasklets: fileChanges.map(change => ({
        model: change.model,
        name: "", // TODO
        messages: change.tasklet_messages,
        lines: change.lines
      }))
    });
  }

  return files;
}
