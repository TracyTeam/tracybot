import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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
});
