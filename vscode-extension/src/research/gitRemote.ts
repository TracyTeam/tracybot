import { spawn } from "child_process";

// Deliberately not routed through utils.ts's runGit — that file imports
// vscode at module scope, which would drag this (and its unit tests) into
// needing the extension host just to load.
//
// repo_url is derived live from the actual git remote rather than something
// the participant types in: for an open-source repo the URL doesn't tell us
// anything we couldn't already find, and for a private one the URL alone
// doesn't grant access either way — so there's no separate consent gate for it.
export function getRemoteUrl(repoPath: string, remoteName: string = "origin"): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("git", ["-C", repoPath, "remote", "get-url", remoteName]);
    let stdout = "";

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.on("close", (code) => { resolve(code === 0 ? (stdout.trim() || null) : null); });
    proc.on("error", () => resolve(null));
  });
}
