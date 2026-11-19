import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { clearInitDeclined, getInitState, isTracyInitialized, recordInitDeclined } from "./initState";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracybot-init-state-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, ".git"));
  return dir;
}

function writeConfig(repo: string, scriptPath: string): void {
  fs.mkdirSync(path.join(repo, ".git", "tracybot"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "tracybot", "config"), `TRACY_SNAPSHOT_SCRIPT=${scriptPath}\n`);
}

describe("initState", () => {
  test("a repo with no Tracybot setup and no decision is undecided", () => {
    assert.equal(getInitState(makeRepo()), "undecided");
  });

  test("a repo whose config points at an existing script is initialized", () => {
    const repo = makeRepo();
    const script = path.join(repo, "tracy.py");
    fs.writeFileSync(script, "");
    writeConfig(repo, script);

    assert.equal(getInitState(repo), "initialized");
    assert.equal(isTracyInitialized(repo), true);
  });

  test("a repo whose config points at a script that no longer exists needs repair, and still counts as initialized", () => {
    const repo = makeRepo();
    writeConfig(repo, path.join(repo, "old-extension-version", "tracy.py"));

    assert.equal(getInitState(repo), "needs-repair");
    assert.equal(isTracyInitialized(repo), true);
  });

  test("declining is remembered until cleared", () => {
    const repo = makeRepo();
    recordInitDeclined(repo);
    assert.equal(getInitState(repo), "declined");
    assert.equal(isTracyInitialized(repo), false);

    clearInitDeclined(repo);
    assert.equal(getInitState(repo), "undecided");
  });

  test("an existing setup wins over a leftover decline", () => {
    const repo = makeRepo();
    recordInitDeclined(repo);
    const script = path.join(repo, "tracy.py");
    fs.writeFileSync(script, "");
    writeConfig(repo, script);

    assert.equal(getInitState(repo), "initialized");
  });

  describe("when .git is a file (linked worktree, submodule)", () => {
    function sh(cmd: string, cwd: string): void {
      execSync(cmd, { cwd, stdio: "pipe" });
    }

    function makeRealRepo(): string {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tracybot-init-state-real-")));
      tmpDirs.push(dir);
      sh("git init -q -b main && git config user.email t@e.com && git config user.name T", dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
      sh("git add -A && git commit -q -m init", dir);
      return dir;
    }

    function addLinkedWorktree(main: string): string {
      const linked = path.join(path.dirname(main), `linked-${path.basename(main)}`);
      tmpDirs.push(linked);
      sh(`git worktree add -q ${linked} -b feat`, main);
      assert.ok(fs.statSync(path.join(linked, ".git")).isFile(), "test setup: .git should be a file here");
      return linked;
    }

    // init.py writes the config into the common git dir; ask git for it
    // rather than assuming ".git", the same way init.py does.
    function writeConfigLikeInitPy(repo: string, scriptPath: string): void {
      const common = path.resolve(repo, execSync("git rev-parse --git-common-dir", { cwd: repo, encoding: "utf8" }).trim());
      fs.mkdirSync(path.join(common, "tracybot"), { recursive: true });
      fs.writeFileSync(path.join(common, "tracybot", "config"), `TRACY_SNAPSHOT_SCRIPT=${scriptPath}\n`);
    }

    test("a linked worktree of an initialized repo counts as initialized", () => {
      const main = makeRealRepo();
      const script = path.join(main, "tracy.py");
      fs.writeFileSync(script, "");
      writeConfigLikeInitPy(main, script);
      const linked = addLinkedWorktree(main);

      assert.equal(getInitState(linked), "initialized");
      assert.equal(isTracyInitialized(linked), true);
    });

    test("declining from a linked worktree is remembered instead of throwing ENOTDIR", () => {
      const main = makeRealRepo();
      const linked = addLinkedWorktree(main);

      recordInitDeclined(linked);
      assert.equal(getInitState(linked), "declined");
      // One answer per repository, shared with the main checkout.
      assert.equal(getInitState(main), "declined");

      clearInitDeclined(linked);
      assert.equal(getInitState(linked), "undecided");
    });

    test("declining inside a submodule is remembered instead of throwing ENOTDIR", () => {
      const lib = makeRealRepo();
      const main = makeRealRepo();
      sh(`git -c protocol.file.allow=always submodule add -q ${lib} sub`, main);
      const sub = path.join(main, "sub");
      assert.ok(fs.statSync(path.join(sub, ".git")).isFile(), "test setup: .git should be a file here");

      recordInitDeclined(sub);
      assert.equal(getInitState(sub), "declined");
    });
  });
});
