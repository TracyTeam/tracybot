import * as fs from 'fs';
import * as path from 'path';

// Kept free of the 'vscode' module so it can be unit-tested directly.
//
// `.git` is a file ("gitdir: ..."), not a directory, in a linked worktree or a
// submodule, so `<repo>/.git/tracybot/...` can't exist there. Tracybot keeps
// its per-repository state in the *common* git dir — where init.py writes the
// config and the git hooks live — which for a linked worktree is found through
// the `commondir` pointer inside the worktree's own git dir.
export function resolveGitDir(repoPath: string): string {
  const dotGit = path.join(repoPath, '.git');
  try {
    if (!fs.statSync(dotGit).isFile()) { return dotGit; }

    const target = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1];
    if (!target) { return dotGit; }

    const gitDir = path.resolve(repoPath, target.trim());
    const commonDirFile = path.join(gitDir, 'commondir');
    if (fs.existsSync(commonDirFile)) {
      return path.resolve(gitDir, fs.readFileSync(commonDirFile, 'utf8').trim());
    }
    return gitDir;
  } catch {
    return dotGit;
  }
}
