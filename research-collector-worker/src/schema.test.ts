import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { submitRequestSchema } from "./schema.ts";

function makeTier1Payload(overrides: Record<string, unknown> = {}) {
  return {
    participant_id: "p_test",
    tasklet_id: "tasklet-1",
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
    consent_level: 1,
    ...overrides,
  };
}

describe("submitRequestSchema", () => {
  test("accepts a well-formed Tier 1 payload", () => {
    const result = submitRequestSchema.safeParse({ payloads: [makeTier1Payload()] });
    assert.equal(result.success, true);
  });

  test("rejects an empty payloads array", () => {
    const result = submitRequestSchema.safeParse({ payloads: [] });
    assert.equal(result.success, false);
  });

  test("rejects a Tier 2 payload missing the Tier 2-only fields", () => {
    const result = submitRequestSchema.safeParse({
      payloads: [makeTier1Payload({ consent_level: 2 })],
    });
    assert.equal(result.success, false);
  });

  test("rejects an unknown consent_level", () => {
    const result = submitRequestSchema.safeParse({
      payloads: [makeTier1Payload({ consent_level: 4 })],
    });
    assert.equal(result.success, false);
  });

  test("accepts agent_source: claude-code", () => {
    const result = submitRequestSchema.safeParse({
      payloads: [makeTier1Payload({ agent_source: "claude-code" })],
    });
    assert.equal(result.success, true);
  });

  test("accepts agent_source: codex", () => {
    const result = submitRequestSchema.safeParse({
      payloads: [makeTier1Payload({ agent_source: "codex" })],
    });
    assert.equal(result.success, true);
  });

  test("rejects an unknown agent_source", () => {
    const result = submitRequestSchema.safeParse({
      payloads: [makeTier1Payload({ agent_source: "cursor" })],
    });
    assert.equal(result.success, false);
  });

  test("rejects a batch larger than 200 payloads", () => {
    const payloads = Array.from({ length: 201 }, (_, i) => makeTier1Payload({ tasklet_id: `t-${i}` }));
    const result = submitRequestSchema.safeParse({ payloads });
    assert.equal(result.success, false);
  });
});
