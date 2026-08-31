import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getRemoteUrl } from "./gitRemote";

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracybot-git-remote-"));
  execSync("git init -q", { cwd: dir });
  return dir;
}

describe("getRemoteUrl", () => {
  test("returns the configured origin URL", async () => {
    const repo = makeRepo();
    execSync("git remote add origin https://github.com/TracyTeam/tracybot.git", { cwd: repo });

    assert.equal(await getRemoteUrl(repo), "https://github.com/TracyTeam/tracybot.git");
  });

  test("returns null when no remote is configured", async () => {
    const repo = makeRepo();
    assert.equal(await getRemoteUrl(repo), null);
  });

  test("returns null for a path that isn't a git repo", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracybot-not-a-repo-"));
    assert.equal(await getRemoteUrl(dir), null);
  });

  test("supports a non-default remote name", async () => {
    const repo = makeRepo();
    execSync("git remote add upstream https://github.com/example/upstream.git", { cwd: repo });

    assert.equal(await getRemoteUrl(repo, "upstream"), "https://github.com/example/upstream.git");
    assert.equal(await getRemoteUrl(repo, "origin"), null);
  });
});
