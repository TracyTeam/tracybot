import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveGitDir } from "./gitDir";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function makeRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tracybot-gitdir-")));
  tmpDirs.push(dir);
  sh("git init -q -b main && git config user.email t@e.com && git config user.name T", dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  sh("git add -A && git commit -q -m init", dir);
  return dir;
}

// What git itself says the shared git dir is, as an absolute real path.
function commonDirAccordingToGit(repo: string): string {
  return fs.realpathSync(path.resolve(repo, sh("git rev-parse --git-common-dir", repo)));
}

describe("resolveGitDir", () => {
  test("a normal repo resolves to its .git directory", () => {
    const repo = makeRepo();
    assert.equal(resolveGitDir(repo), path.join(repo, ".git"));
  });

  test("a folder that isn't a repo falls back to <path>/.git", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tracybot-notrepo-")));
    tmpDirs.push(dir);
    assert.equal(resolveGitDir(dir), path.join(dir, ".git"));
  });

  test("a linked worktree (.git is a file) resolves to the main repo's shared git dir", () => {
    const main = makeRepo();
    const linked = path.join(main, "..", `linked-${path.basename(main)}`);
    tmpDirs.push(linked);
    sh(`git worktree add -q ${linked} -b feat`, main);

    assert.ok(fs.statSync(path.join(linked, ".git")).isFile(), "test setup: .git should be a file here");
    assert.equal(fs.realpathSync(resolveGitDir(linked)), commonDirAccordingToGit(linked));
    assert.equal(fs.realpathSync(resolveGitDir(linked)), fs.realpathSync(path.join(main, ".git")));
  });

  test("a submodule (.git is a file) resolves to the submodule's own git dir", () => {
    const lib = makeRepo();
    const main = makeRepo();
    sh(`git -c protocol.file.allow=always submodule add -q ${lib} sub`, main);
    const sub = path.join(main, "sub");

    assert.ok(fs.statSync(path.join(sub, ".git")).isFile(), "test setup: .git should be a file here");
    assert.equal(fs.realpathSync(resolveGitDir(sub)), commonDirAccordingToGit(sub));
  });

  test("a worktree and the repo it came from share one location", () => {
    const main = makeRepo();
    const linked = path.join(main, "..", `linked2-${path.basename(main)}`);
    tmpDirs.push(linked);
    sh(`git worktree add -q ${linked} -b feat2`, main);

    assert.equal(fs.realpathSync(resolveGitDir(linked)), fs.realpathSync(resolveGitDir(main)));
  });
});
