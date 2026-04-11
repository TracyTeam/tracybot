import * as vscode from 'vscode';

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
