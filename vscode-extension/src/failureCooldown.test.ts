import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CooldownStore, FAILURE_RETRY_COOLDOWN_MS, clearFailureCooldown, notifyFailureOnce } from "./failureCooldown";

function makeStore(): CooldownStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T,>(key: string) => data.get(key) as T | undefined,
    update: (key: string, value: unknown) => { data.set(key, value); },
  };
}

describe("failureCooldown", () => {
  test("notifyFailureOnce notifies on the first failure", async () => {
    const store = makeStore();
    let calls = 0;
    await notifyFailureOnce(store, "k", () => { calls++; });
    assert.equal(calls, 1);
  });

  test("notifyFailureOnce does not re-notify for a second failure within the cooldown window", async () => {
    const store = makeStore();
    let calls = 0;
    await notifyFailureOnce(store, "k", () => { calls++; });
    await notifyFailureOnce(store, "k", () => { calls++; });
    assert.equal(calls, 1);
  });

  test("notifyFailureOnce notifies again once the cooldown window has elapsed", async () => {
    const store = makeStore();
    let calls = 0;
    store.data.set("k", Date.now() - (FAILURE_RETRY_COOLDOWN_MS + 1000));
    await notifyFailureOnce(store, "k", () => { calls++; });
    assert.equal(calls, 1);
  });

  test("clearFailureCooldown immediately un-suppresses the next failure", async () => {
    const store = makeStore();
    let calls = 0;
    await notifyFailureOnce(store, "k", () => { calls++; });
    await clearFailureCooldown(store, "k");
    await notifyFailureOnce(store, "k", () => { calls++; });
    assert.equal(calls, 2);
  });

  test("cooldowns for different keys are independent", async () => {
    const store = makeStore();
    let callsA = 0;
    let callsB = 0;
    await notifyFailureOnce(store, "a", () => { callsA++; });
    await notifyFailureOnce(store, "b", () => { callsB++; });
    await notifyFailureOnce(store, "a", () => { callsA++; });
    await notifyFailureOnce(store, "b", () => { callsB++; });
    assert.equal(callsA, 1);
    assert.equal(callsB, 1);
  });
});
