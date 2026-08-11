import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { getBunInstallCommand } from "./bunInstall";

describe("bunInstall", () => {
  test("uses the PowerShell installer on Windows", () => {
    assert.equal(getBunInstallCommand("win32"), 'powershell -c "irm bun.sh/install.ps1 | iex"');
  });

  test("uses the curl installer on macOS", () => {
    assert.equal(getBunInstallCommand("darwin"), "curl -fsSL https://bun.sh/install | bash");
  });

  test("uses the curl installer on Linux", () => {
    assert.equal(getBunInstallCommand("linux"), "curl -fsSL https://bun.sh/install | bash");
  });
});
