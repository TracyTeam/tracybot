import * as fs from 'fs';
import * as path from 'path';

// Research Mode consent is per-repository, not machine-wide — a participant
// agreeing to share one project's Tasklet history shouldn't silently enroll
// every other repo they ever open in VS Code afterward. Storing the decision
// inside .git/tracybot/ (rather than a VS Code Setting) keeps it naturally
// scoped to this one repo, and — since .git isn't tracked within itself —
// never risks ending up committed and pushed to a shared remote the way a
// workspace-level Setting in .vscode/settings.json could.
export type RepoConsent =
  | { decision: 'enabled'; consentTier: 1 | 2 }
  | { decision: 'declined' };

function consentFilePath(repoPath: string): string {
  return path.join(repoPath, '.git', 'tracybot', 'research-consent.json');
}

export function readRepoConsent(repoPath: string): RepoConsent | undefined {
  const filePath = consentFilePath(repoPath);
  if (!fs.existsSync(filePath)) { return undefined; }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

export function writeRepoConsent(repoPath: string, consent: RepoConsent): void {
  const filePath = consentFilePath(repoPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(consent, null, 2) + '\n');
}

export function isResearchModeEnabledForRepo(repoPath: string): boolean {
  return readRepoConsent(repoPath)?.decision === 'enabled';
}

export function getConsentTierForRepo(repoPath: string): 1 | 2 {
  const consent = readRepoConsent(repoPath);
  return consent?.decision === 'enabled' ? consent.consentTier : 1;
}
