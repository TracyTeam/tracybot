import * as vscode from 'vscode';
import { FileLineDelta, TaskletUI, LineMap } from './history/types';
import { runGit } from './history/helpers';

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
  if (!gitExtension) { return undefined; }

  const git = gitExtension.getAPI(1);
  if (!git) { return undefined; }

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
    if (repo) { return repo.rootUri.fsPath; }
  }

  // Fall back to the first repo if no active file match
  return git.repositories[0]?.rootUri.fsPath;
}


export async function getLineDeltas(
  repoPath: string
): Promise<Map<string, FileLineDelta>> {
  const output = await runGit(repoPath, [
    "diff",
    "--no-color",
    "--unified=0",
    "HEAD",
  ]);

  const result = new Map<string, FileLineDelta>();
  if (!output) { return result; }

  const lines = output.split("\n");

  let currentFile: string | null = null;
  let oldLine = 0;
  let newLine = 0;
  let hunkOldStart = 0;
  let hunkOldCount = 0;
  let hunkNewCount = 0;
  let removedBuffer: number[] = [];
  let addedBuffer: number[] = [];

  function ensureFile(file: string) {
    if (!result.has(file)) {
      result.set(file, {
        consumed: [],
        shifts: [],
      });
    }
    return result.get(file)!;
  }

  // Now takes explicit counts instead of reading shared state
  function finalizeHunk(oldCount: number, newCount: number) {
    if (!currentFile) { return; }
    const file = ensureFile(currentFile);

    // Track any hunk that consumed old-file lines, regardless of net delta
    if (oldCount > 0) {
      file.consumed.push({ at: hunkOldStart, oldCount });
    }

    const delta = newCount - oldCount;
    if (delta !== 0) {
      file.shifts.push({ at: hunkOldStart, delta, oldCount });
    }

    removedBuffer = [];
    addedBuffer = [];
  }

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      finalizeHunk(hunkOldCount, hunkNewCount);
      hunkOldCount = 0;
      hunkNewCount = 0;
      const parts = line.split(" ");
      currentFile = parts[3]?.replace("b/", "") ?? null;
      if (currentFile) { ensureFile(currentFile); }
    }
    else if (currentFile && line.startsWith("@@")) {
      finalizeHunk(hunkOldCount, hunkNewCount);

      const match = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?/);
      if (match) {
        const oldStart = parseInt(match[1], 10);
        const oldCnt = match[2] ? parseInt(match[2], 10) : 1;
        const newStart = parseInt(match[3], 10);
        const newCnt = match[4] ? parseInt(match[4], 10) : 1;

        oldLine = oldStart;
        newLine = newStart;
        hunkOldCount = oldCnt;
        hunkNewCount = newCnt;
        hunkOldStart = oldCnt === 0 ? oldStart : oldStart - 1;

        removedBuffer = [];
        addedBuffer = [];
      }
    }
    else if (currentFile && line.startsWith("-")) {
      removedBuffer.push(oldLine - 1);
      oldLine++;
    }
    else if (currentFile && line.startsWith("+")) {
      addedBuffer.push(newLine - 1);
      newLine++;
    }
    else if (currentFile && line && !line.startsWith("\\")) {
      oldLine++;
      newLine++;
    }
  }

  finalizeHunk(hunkOldCount, hunkNewCount);
  return result;
}


export function applyDiffToLineMap(
  lineMap: LineMap,
  deltas: Map<string, FileLineDelta>
): LineMap {
  const updated = new Map<string, Map<number, TaskletUI>>();

  for (const [file, fileMap] of lineMap) {
    const delta = deltas.get(file);

    if (!delta) {
      updated.set(file, new Map(fileMap));
      continue;
    }

    const clonedTasklets = new Map<TaskletUI, TaskletUI>();
    const cloneTasklet = (t: TaskletUI): TaskletUI => {
      if (!clonedTasklets.has(t)) {
        clonedTasklets.set(t, { ...t, lines: [...t.lines] });
      }
      return clonedTasklets.get(t)!;
    };

    const newFileMap = new Map<number, TaskletUI>();

    for (const [line, tasklet] of fileMap) {
      // Drop lines consumed by any hunk that had removals (oldCount > 0).
      // A line is consumed if it falls within [shift.at, shift.at + oldCount - 1].
      const isConsumed = delta.consumed.some(c =>
        line >= c.at &&
        line < c.at + c.oldCount
      );

      if (isConsumed) { continue; }

      let newLine = line;
      for (const shift of delta.shifts) {
        const hunkEnd = shift.at + shift.oldCount - 1;
        if (line > hunkEnd) {
          newLine += shift.delta;
        }
      }

      if (newLine >= 0) {
        const cloned = cloneTasklet(tasklet);
        const idx = cloned.lines.indexOf(line + 1);
        if (idx !== -1) {
          cloned.lines[idx] = newLine + 1;
        }
        newFileMap.set(newLine, cloned);
      }
    }

    updated.set(file, newFileMap);
  }

  return updated;
}
