import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { submitPayloads } from "./collectorRepo";
import { Tier1Payload } from "./types";

function makePayload(overrides: Partial<Tier1Payload> = {}): Tier1Payload {
  return {
    participant_id: "p_test",
    tasklet_id: "tasklet-1",
    session_id: "session-1",
    project_tag: "test-alias",
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
    consent_level: 1,
    ...overrides,
  };
}

describe("submitPayloads", () => {
  const originalFetch = global.fetch;
  let lastRequest: { url: string; init: RequestInit } | undefined;

  afterEach(() => {
    global.fetch = originalFetch;
    lastRequest = undefined;
  });

  function stubFetch(response: { status: number; body: unknown }): void {
    global.fetch = (async (url: string, init: RequestInit) => {
      lastRequest = { url, init };
      return new Response(JSON.stringify(response.body), { status: response.status });
    }) as typeof fetch;
  }

  test("returns [] without making a request when there's nothing to send", async () => {
    stubFetch({ status: 200, body: { sent: [], failed: [] } });
    const result = await submitPayloads([]);
    assert.deepEqual(result, []);
    assert.equal(lastRequest, undefined);
  });

  test("sends all payloads in one request and returns the confirmed ids", async () => {
    stubFetch({ status: 200, body: { sent: ["tasklet-1", "tasklet-2"], failed: [] } });

    const result = await submitPayloads([makePayload({ tasklet_id: "tasklet-1" }), makePayload({ tasklet_id: "tasklet-2" })]);

    assert.deepEqual(result, ["tasklet-1", "tasklet-2"]);
    assert.equal(lastRequest?.init.method, "POST");
    const sentBody = JSON.parse(lastRequest!.init.body as string);
    assert.equal(sentBody.payloads.length, 2);
  });

  test("only returns tasklet ids the relay actually confirmed", async () => {
    stubFetch({ status: 200, body: { sent: ["tasklet-1"], failed: ["tasklet-2"] } });

    const result = await submitPayloads([makePayload({ tasklet_id: "tasklet-1" }), makePayload({ tasklet_id: "tasklet-2" })]);

    assert.deepEqual(result, ["tasklet-1"]);
  });

  test("throws on a non-2xx response so the caller keeps everything queued", async () => {
    stubFetch({ status: 401, body: { error: "Unauthorized" } });

    await assert.rejects(() => submitPayloads([makePayload()]));
  });
});
