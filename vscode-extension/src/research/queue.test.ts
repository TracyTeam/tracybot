import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  KeyValueStore,
  queueTaskletForSubmission,
  getTodaysSentCount,
  getPendingPayloads,
  isTaskletQueued,
} from "./queue";
import { Tier1Payload } from "./types";

function makeStore(): KeyValueStore {
  const data = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue: T): T {
      return data.has(key) ? (data.get(key) as T) : defaultValue;
    },
    update(key: string, value: unknown) {
      data.set(key, value);
      return Promise.resolve();
    },
  };
}

function makePayload(taskletId: string): Tier1Payload {
  return {
    participant_id: "p_test",
    tasklet_id: taskletId,
    session_id: "session-1",
    agent_source: "opencode",
    repo_url: null,
    generated_at: "2026-07-24T10:00:00.000Z",
    submitted_at: "2026-07-24T15:00:00.000Z",
    model_provider: "anthropic",
    model_id: "claude-sonnet-4-6",
    plan_prompt_count: 1,
    has_build: true,
    files_touched_ext: [".ts"],
    files_touched_count: 1,
    lines_changed_total: 2,
    ownership_flip: false,
    bleu_score: null,
    review_latency_sec: null,
    history_tasklet_ids: [],
    consent_level: 1,
    plan_prompts: ["Plan this"],
    plan_responses: ["Here's the plan"],
    build_prompt: "Build it",
    build_response: "Done",
    questions_answers: [],
  };
}

describe("queue", () => {
  test("getTodaysSentCount is 0 for an empty store", () => {
    const store = makeStore();
    assert.equal(getTodaysSentCount(store), 0);
  });

  test("getPendingPayloads is [] for an empty store", () => {
    const store = makeStore();
    assert.deepEqual(getPendingPayloads(store), []);
  });

  test("isTaskletQueued is false before queueing", () => {
    const store = makeStore();
    assert.equal(isTaskletQueued(store, "tasklet-1"), false);
  });

  test("queueTaskletForSubmission appends the payload and marks it queued", async () => {
    const store = makeStore();
    await queueTaskletForSubmission(store, makePayload("tasklet-1"));

    assert.equal(isTaskletQueued(store, "tasklet-1"), true);
    const pending = getPendingPayloads(store);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].tasklet_id, "tasklet-1");
  });

  test("queueTaskletForSubmission increments today's count", async () => {
    const store = makeStore();
    await queueTaskletForSubmission(store, makePayload("tasklet-1"));
    await queueTaskletForSubmission(store, makePayload("tasklet-2"));
    await queueTaskletForSubmission(store, makePayload("tasklet-3"));

    assert.equal(getTodaysSentCount(store), 3);
    assert.equal(getPendingPayloads(store).length, 3);
  });

  test("queueTaskletForSubmission is idempotent per taskletId", async () => {
    const store = makeStore();
    await queueTaskletForSubmission(store, makePayload("tasklet-1"));
    await queueTaskletForSubmission(store, makePayload("tasklet-1"));
    await queueTaskletForSubmission(store, makePayload("tasklet-1"));

    assert.equal(getTodaysSentCount(store), 1);
    assert.equal(getPendingPayloads(store).length, 1);
  });

  test("getTodaysSentCount resets to 0 when the stored digest is from a previous day", () => {
    const store = makeStore();
    store.update("tracybot.researchMode.dailyDigest", { date: "2000-01-01", count: 42 });

    assert.equal(getTodaysSentCount(store), 0);
  });

  test("queueTaskletForSubmission resets (not accumulates) the count across a day boundary", async () => {
    const store = makeStore();
    store.update("tracybot.researchMode.dailyDigest", { date: "2000-01-01", count: 42 });

    await queueTaskletForSubmission(store, makePayload("tasklet-1"));

    // Should start a fresh count for today, not continue from the stale 42
    assert.equal(getTodaysSentCount(store), 1);
  });

  test("pending payloads from a stale day are preserved, not cleared, across the digest rollover", async () => {
    const store = makeStore();
    await queueTaskletForSubmission(store, makePayload("tasklet-old"));
    store.update("tracybot.researchMode.dailyDigest", { date: "2000-01-01", count: 1 });

    await queueTaskletForSubmission(store, makePayload("tasklet-new"));

    // The digest count resets, but the pending queue (what Task 4 will actually
    // send) must keep accumulating everything not yet submitted.
    assert.equal(getTodaysSentCount(store), 1);
    assert.deepEqual(
      getPendingPayloads(store).map(p => p.tasklet_id),
      ["tasklet-old", "tasklet-new"]
    );
  });
});
