import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CooldownStore } from "./failureCooldown";
import { FetchLike, SYNCED_VERSION_KEY, isSyncedFor, pluginUrlsFor, syncPluginFile } from "./opencodePluginSync";

function makeStore(): CooldownStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T,>(key: string) => data.get(key) as T | undefined,
    update: (key: string, value: unknown) => { data.set(key, value); },
  };
}

// Serves `body` for the URLs in `responses`, 404 for everything else, and
// records every URL requested.
function makeFetch(responses: Record<string, string>): FetchLike & { requested: string[] } {
  const requested: string[] = [];
  const fn = async (url: string) => {
    requested.push(url);
    const body = responses[url];
    return {
      ok: body !== undefined,
      status: body !== undefined ? 200 : 404,
      arrayBuffer: async () => new TextEncoder().encode(body ?? "").buffer as ArrayBuffer,
    };
  };
  return Object.assign(fn, { requested });
}

function tempPluginPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tracybot-oc-")), "plugin", "tracybot-oc.js");
}

const [PINNED, LATEST] = pluginUrlsFor("tracybot-oc.js", "1.3.11");

describe("opencodePluginSync", () => {
  test("pluginUrlsFor tries this version's release before latest", () => {
    assert.equal(PINNED, "https://github.com/TracyTeam/tracybot/releases/download/v1.3.11/tracybot-oc.js");
    assert.equal(LATEST, "https://github.com/TracyTeam/tracybot/releases/latest/download/tracybot-oc.js");
  });

  test("installs the plugin when none exists", async () => {
    const dest = tempPluginPath();
    const store = makeStore();
    const result = await syncPluginFile(dest, "1.3.11", store, makeFetch({ [PINNED]: "new" }));
    assert.equal(result, "installed");
    assert.equal(fs.readFileSync(dest, "utf8"), "new");
    assert.equal(store.data.get(SYNCED_VERSION_KEY), "1.3.11");
  });

  test("replaces an outdated existing plugin", async () => {
    const dest = tempPluginPath();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, "old 1.x plugin");
    const store = makeStore();
    const result = await syncPluginFile(dest, "1.3.11", store, makeFetch({ [PINNED]: "new" }));
    assert.equal(result, "updated");
    assert.equal(fs.readFileSync(dest, "utf8"), "new");
    assert.deepEqual(fs.readdirSync(path.dirname(dest)), ["tracybot-oc.js"], "no temp file left behind");
  });

  test("reports unchanged, without rewriting, when the content already matches", async () => {
    const dest = tempPluginPath();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, "same");
    const before = fs.statSync(dest).mtimeMs;
    const store = makeStore();
    const result = await syncPluginFile(dest, "1.3.11", store, makeFetch({ [PINNED]: "same" }));
    assert.equal(result, "unchanged");
    assert.equal(fs.statSync(dest).mtimeMs, before);
    assert.equal(store.data.get(SYNCED_VERSION_KEY), "1.3.11");
  });

  test("falls back to the latest release when this version has none", async () => {
    const dest = tempPluginPath();
    const fetchFn = makeFetch({ [LATEST]: "latest" });
    const result = await syncPluginFile(dest, "1.3.11", makeStore(), fetchFn);
    assert.equal(result, "installed");
    assert.equal(fs.readFileSync(dest, "utf8"), "latest");
    assert.deepEqual(fetchFn.requested, [PINNED, LATEST]);
  });

  test("throws, leaving the existing plugin and synced version alone, when every download fails", async () => {
    const dest = tempPluginPath();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, "old");
    const store = makeStore();
    await assert.rejects(syncPluginFile(dest, "1.3.11", store, makeFetch({})), /Plugin download failed: \(404\)/);
    assert.equal(fs.readFileSync(dest, "utf8"), "old");
    assert.equal(store.data.get(SYNCED_VERSION_KEY), undefined);
  });

  test("isSyncedFor needs both the file and a matching synced version", async () => {
    const dest = tempPluginPath();
    const store = makeStore();
    store.update(SYNCED_VERSION_KEY, "1.3.11");
    assert.equal(isSyncedFor(dest, "1.3.11", store), false, "file missing");

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, "x");
    assert.equal(isSyncedFor(dest, "1.3.11", store), true);
    assert.equal(isSyncedFor(dest, "1.3.12", store), false, "extension updated since");
    assert.equal(isSyncedFor(dest, "1.3.11", makeStore()), false, "never synced, e.g. installed before this fix");
  });
});
