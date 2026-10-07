import * as fs from 'fs';
import * as path from 'path';

// Kept free of the 'vscode' module so it can be unit-tested directly.
export type InitState = 'initialized' | 'needs-repair' | 'declined' | 'undecided';

function configPath(repoPath: string): string {
  return path.join(repoPath, '.git', 'tracybot', 'config');
}

// Stored inside .git like research-consent.json, so the choice stays scoped
// to this one repo and is never committed or pushed.
function declinedMarkerPath(repoPath: string): string {
  return path.join(repoPath, '.git', 'tracybot', 'init-declined');
}

// init.py writes TRACY_SNAPSHOT_SCRIPT as an absolute path into *this*
// extension version's own directory (assets/tracking/tracy.py). VS Code
// deletes the previous version's directory on every auto-update, so a repo
// initialized under an older version silently ends up pointing at a script
// that no longer exists. A missing config file's mere *existence* isn't
// enough to call a repo "initialized" — the target it points to has to
// still be there, or every future commit hook run fails to find it.
function isTracySnapshotScriptValid(tracyConfigPath: string): boolean {
  try {
    const content = fs.readFileSync(tracyConfigPath, 'utf8');
    const match = content.match(/^TRACY_SNAPSHOT_SCRIPT=(.+)$/m);
    return !!match && fs.existsSync(match[1].trim());
  } catch {
    return false;
  }
}

export function getInitState(repoPath: string): InitState {
  const config = configPath(repoPath);
  if (fs.existsSync(config)) {
    return isTracySnapshotScriptValid(config) ? 'initialized' : 'needs-repair';
  }
  return fs.existsSync(declinedMarkerPath(repoPath)) ? 'declined' : 'undecided';
}

export function isTracyInitialized(repoPath: string): boolean {
  const state = getInitState(repoPath);
  return state === 'initialized' || state === 'needs-repair';
}

export function recordInitDeclined(repoPath: string): void {
  const marker = declinedMarkerPath(repoPath);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, '');
}

export function clearInitDeclined(repoPath: string): void {
  fs.rmSync(declinedMarkerPath(repoPath), { force: true });
}
