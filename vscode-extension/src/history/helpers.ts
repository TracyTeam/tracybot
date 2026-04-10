import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { Change, History } from "./types";

export async function runGit(repoPath: string, args: string[]): Promise<string> {
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

// Returns a map of all files that changed between two trees.
export async function getDiff(repoPath: string, fromTree: string, toTree: string): Promise<Map<string, number[]>> {
  const output = await runGit(repoPath, ["diff", "--no-color", "--numstat", `${fromTree}..${toTree}`]);
  const fileChanges = new Map<string, number[]>();
  
  if (!output) {
    return fileChanges;
}
  
  for (const line of output.split("\n")) {
    // <added> <deleted> <file>
    // Ddeletions show "-" instead of a number
    const match = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
    if (!match) {
        continue;
    }
    
    const [, oldCount, newCount, filePath] = match;
    const added = newCount !== "-" ? parseInt(newCount, 10) : 0;
    const deleted = oldCount !== "-" ? parseInt(oldCount, 10) : 0;
    
    if (added > 0 || deleted > 0) {
      fileChanges.set(filePath, []);
    }
  }
  
  return fileChanges;
}

// Gonna be honest, completely vibed, hunks hurt my brain
export async function getChangedLines(repoPath: string, fromTree: string, toTree: string, filePath: string): Promise<number[]> {
  // Get unified diff with 0 context lines (minimal output)
  const output = await runGit(repoPath, ["diff", "--no-color", "--unified=0", `${fromTree}..${toTree}`, "--", filePath]);
  const lines: number[] = [];
  
  if (!output) {
    return lines;
}
  
  // Regex to match hunk headers: @@ -start,count +start,count @@
  const hunkHeaderRegex = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?/gm;
  let match;
  
  // Find each hunk in the diff
  while ((match = hunkHeaderRegex.exec(output)) !== null) {
    // Extract the "to" side starting line (group 3)
    const newStart = parseInt(match[3], 10);
    // Extract the count of added lines (group 4, default to 1 if not present)
    const newCount = match[4] ? parseInt(match[4], 10) : 1;
    
    // Add each line number that was added
    for (let i = 0; i < newCount; i++) {
      lines.push(newStart + i);
    }
  }
  
  return lines;
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