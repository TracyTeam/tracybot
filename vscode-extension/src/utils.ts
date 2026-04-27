import * as vscode from 'vscode';
import pLimit from 'p-limit';
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { Change, CommitInfo, DiffHunk, History } from "./history/types";

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

export async function getTracyLocalRefCommit(repoPath: string, tracyId: string): Promise<string | null> {
  const refPath = path.join(repoPath, ".git", "refs", "tracy-local", tracyId);
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
  toTree: string | "WORKING_TREE", 
  filePath?: string
): Promise<Map<string, DiffHunk[]>> {
  const args = ["diff", "--no-color", "--unified=0"];
  
  if (toTree === "WORKING_DIR") {
    args.push(fromTree);
  } else {
    args.push(`${fromTree}..${toTree}`);
  }

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

export async function fileExists(
  repoPath: string,
  treeHash: string,
  filePath: string
): Promise<boolean> {
  try {
    await runGit(repoPath, [
      "cat-file",
      "-e",
      `${treeHash}:${filePath}`,
    ]);

    return true;
  } catch {
    return false;
  }
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

export async function getActiveTracyId(repoPath: string): Promise<string | null> {
  try {
    return await runGit(repoPath, ["config", "--get", "tracy.current-id"]);
  } catch {
    return null;
  }
}

export async function getActiveHiddenCommit(repoPath: string, tracyId: string): Promise<string | null> {
  try {
    return await runGit(repoPath, ["config", "--get", `tracy.${tracyId}.hidden`]);
  } catch {
    return null;
  }
}

export async function getUserName(repoPath: string): Promise<string> {
  try {
    return await runGit(repoPath, ["config", "--get", "user.name"]);
  } catch {
    return "User";
  }
}

export function isAiChange(commit: CommitInfo): boolean {
  return commit.authorEmail.toLowerCase() === "opencode";
}

export function groupChangesByFile(changes: Change[]): History["files"] {
  const fileMap = new Map<string, Change[]>();

  for (const change of changes) {
    const existing = fileMap.get(change.filePath) || [];

    const duplicate = existing.find(e => e.snapshotHash === change.snapshotHash);
    if (duplicate) {
      // remove the duplicates by turning them into a set then back to an array
      duplicate.lines = Array.from(new Set([...duplicate.lines, ...change.lines])).sort((a, b) => a - b);
    } else {
      existing.push(change);
    }

    fileMap.set(change.filePath, existing);
  }

  // TODO: maybe change the schema to not have this array conversion?
  const files: History["files"] = [];
  for (const [path, fileChanges] of fileMap) {
    files.push({
      path,
      tasklets: fileChanges.map(change => ({
        model: change.model,
        name: change.name,
        messages: change.tasklet_messages,
        lines: change.lines
      }))
    });
  }

  return files;
}

// Helper that splits a sorted list of lines into contiguous chunks
// e.g. [1,2,3,100,101] => [[1,2,3], [100,101]]
export function getContiguousChunks(lines: number[]): number[][] {
  if (lines.length === 0) { return []; }

  const sorted = [...lines].sort((a, b) => a - b);
  const chunks: number[][] = [[sorted[0]]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const lastChunk = chunks[chunks.length - 1];
    const lastLine = lastChunk[lastChunk.length - 1];

    // If this line is consecutive with the previous, add to current chunk
    if (current === lastLine + 1) {
      lastChunk.push(current);
    } else {
      // Otherwise start a new chunk
      chunks.push([current]);
    }
  }

  return chunks;
}

export async function getRepoPath(): Promise<string | undefined> {
  // Get the built-in git extension
  const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
  if (!gitExtension) { 
    return undefined; 
  }

  const git = gitExtension.getAPI(1);
  if (!git) { 
    return undefined; 
  }

  // If there's only one repo, return it directly
  if (git.repositories.length === 1) {
    return git.repositories[0].rootUri.fsPath;
  }

  // If there are multiple repos, try to find the one containing the active file
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    const repo = git.repositories.find((r: { rootUri: vscode.Uri }) =>
      activeEditor.document.uri.fsPath.startsWith(r.rootUri.fsPath)
    );

    if (repo) { 
      return repo.rootUri.fsPath; 
    }
  }

  // Fall back to the first repo if no active file match
  return git.repositories[0]?.rootUri.fsPath;
}
