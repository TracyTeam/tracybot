import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import {
  readRepoConsent,
  writeRepoConsent,
  isResearchModeEnabledForRepo,
  getConsentTierForRepo,
} from "./repoConsent";

function makeRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tracybot-repo-consent-"));
}

describe("repoConsent", () => {
  test("an undecided repo (no consent file) is not enabled and reads as undefined", () => {
    const repo = makeRepo();
    assert.equal(readRepoConsent(repo), undefined);
    assert.equal(isResearchModeEnabledForRepo(repo), false);
    assert.equal(getConsentTierForRepo(repo), 1);
  });

  test("writeRepoConsent persists an enabled decision under .git/tracybot/", () => {
    const repo = makeRepo();
    writeRepoConsent(repo, { decision: "enabled", consentTier: 2 });

    assert.ok(fs.existsSync(path.join(repo, ".git", "tracybot", "research-consent.json")));
    assert.equal(isResearchModeEnabledForRepo(repo), true);
    assert.equal(getConsentTierForRepo(repo), 2);
  });

  test("a declined repo is not enabled but is still a terminal (non-undefined) decision", () => {
    const repo = makeRepo();
    writeRepoConsent(repo, { decision: "declined" });

    assert.equal(isResearchModeEnabledForRepo(repo), false);
    assert.notEqual(readRepoConsent(repo), undefined);
    assert.equal(readRepoConsent(repo)?.decision, "declined");
  });

  test("consent for one repo does not leak into a sibling repo", () => {
    const repoA = makeRepo();
    const repoB = makeRepo();
    writeRepoConsent(repoA, { decision: "enabled", consentTier: 2 });

    assert.equal(isResearchModeEnabledForRepo(repoA), true);
    assert.equal(isResearchModeEnabledForRepo(repoB), false);
    assert.equal(readRepoConsent(repoB), undefined);
  });

  test("a corrupted consent file is treated as undecided, not a crash", () => {
    const repo = makeRepo();
    const filePath = path.join(repo, ".git", "tracybot", "research-consent.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{ not valid json");

    assert.equal(readRepoConsent(repo), undefined);
    assert.equal(isResearchModeEnabledForRepo(repo), false);
  });

  test("consent can be written and read back from a linked worktree, where .git is a file", () => {
    const main = makeRepo();
    execSync("git init -q -b main && git config user.email t@e.com && git config user.name T", { cwd: main });
    fs.writeFileSync(path.join(main, "a.txt"), "x\n");
    execSync("git add -A && git commit -q -m init", { cwd: main });
    const linked = path.join(main, "..", `linked-${path.basename(main)}`);
    execSync(`git worktree add -q ${linked} -b feat`, { cwd: main });

    try {
      assert.ok(fs.statSync(path.join(linked, ".git")).isFile(), "test setup: .git should be a file here");

      writeRepoConsent(linked, { decision: "declined" });
      assert.equal(readRepoConsent(linked)?.decision, "declined");

      // One decision per repository: the main checkout sees the same answer.
      assert.equal(readRepoConsent(main)?.decision, "declined");
    } finally {
      fs.rmSync(linked, { recursive: true, force: true });
    }
  });
});
