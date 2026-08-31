import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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
});
