import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { History, TaskletMessage } from "../history/types";
import { buildTaskletResearchPayloads } from "./buildResearchPayloads";
import { ParticipantContext, Tier2Payload, Tier3Payload } from "./types";

const PARTICIPANT: ParticipantContext = {
  participantId: "p_test",
  repoUrl: null,
};
const SUBMITTED_AT = "2026-07-24T15:00:00.000Z";

type TaskletOverrides = Partial<History["files"][number]["tasklets"][number]>;

function makeTasklet(overrides: TaskletOverrides = {}): History["files"][number]["tasklets"][number] {
  return {
    id: "snapshot-hash-1",
    model: "opencode",
    name: "Add a feature",
    messages: [
      { stage: "plan", type: "prompt", model: "anthropic/claude-sonnet-4-6", message: "Plan this" },
      { stage: "plan", type: "response", model: "anthropic/claude-sonnet-4-6", message: "Here's the plan" },
      { stage: "build", type: "prompt", model: "anthropic/claude-sonnet-4-6", message: "Build it" },
      { stage: "build", type: "response", model: "anthropic/claude-sonnet-4-6", message: "Done" },
    ],
    lines: [1, 2],
    ghostLines: [],
    originCommitHash: "commit-hash-1",
    taskletId: "tasklet-1",
    sessionId: "session-1",
    questions: [],
    taskletGeneratedAt: 1_753_350_000_000,
    buildCompletedAt: 1_753_350_020_000,
    originCommitAuthorDate: "2026-07-24T10:00:00.000Z",
    originCommitCommitterDate: "2026-07-24T10:00:20.000Z",
    diffHunks: [],
    ...overrides,
  };
}

function makeHistory(files: { path: string; tasklets: History["files"][number]["tasklets"] }[]): History {
  return { id: "head-commit", files };
}

describe("buildTaskletResearchPayloads", () => {
  test("builds a Tier 1 payload with correct base fields", () => {
    const history = makeHistory([{ path: "src/app.ts", tasklets: [makeTasklet()] }]);
    const payloads = buildTaskletResearchPayloads(history, 1, PARTICIPANT, SUBMITTED_AT);

    assert.equal(payloads.length, 1);
    const p = payloads[0];
    assert.equal(p.consent_level, 1);
    assert.equal(p.tasklet_id, "tasklet-1");
    assert.equal(p.session_id, "session-1");
    assert.equal(p.participant_id, "p_test");
    assert.equal(p.agent_source, "opencode");
    assert.equal(p.repo_url, null);
    assert.equal(p.submitted_at, SUBMITTED_AT);
    assert.equal(p.generated_at, new Date(1_753_350_000_000).toISOString());
    assert.equal(p.model_provider, "anthropic");
    assert.equal(p.model_id, "claude-sonnet-4-6");
    assert.equal(p.plan_prompt_count, 1);
    assert.equal(p.has_build, true);
    assert.deepEqual(p.files_touched_ext, [".ts"]);
    assert.equal(p.files_touched_count, 1);
    assert.equal(p.lines_changed_total, 2);
    assert.equal(p.ownership_flip, false);

    // Tier 1 must not leak Tier 2/3 fields
    assert.equal("plan_prompts" in p, false);
    assert.equal("diff_hunks" in p, false);
  });

  test("skips Tasklets with no taskletId (legacy cached data)", () => {
    const history = makeHistory([
      { path: "src/app.ts", tasklets: [makeTasklet({ taskletId: undefined })] },
    ]);
    const payloads = buildTaskletResearchPayloads(history, 1, PARTICIPANT, SUBMITTED_AT);
    assert.equal(payloads.length, 0);
  });

  test("groups a single Tasklet's records across multiple files", () => {
    const tasklet = makeTasklet();
    const history = makeHistory([
      { path: "src/app.ts", tasklets: [{ ...tasklet, lines: [1, 2], ghostLines: [] }] },
      { path: "src/helper.py", tasklets: [{ ...tasklet, lines: [5], ghostLines: [6] }] },
    ]);
    const payloads = buildTaskletResearchPayloads(history, 1, PARTICIPANT, SUBMITTED_AT);

    assert.equal(payloads.length, 1);
    const p = payloads[0];
    assert.equal(p.files_touched_count, 2);
    assert.deepEqual([...p.files_touched_ext].sort(), [".py", ".ts"]);
    // 2 lines + 0 ghost (file 1) + 1 line + 1 ghost (file 2) = 4
    assert.equal(p.lines_changed_total, 4);
    assert.equal(p.ownership_flip, true);
  });

  test("keeps distinct Tasklets separate", () => {
    const history = makeHistory([
      {
        path: "src/app.ts",
        tasklets: [
          makeTasklet({ taskletId: "tasklet-a", sessionId: "session-a" }),
          makeTasklet({ taskletId: "tasklet-b", sessionId: "session-b" }),
        ],
      },
    ]);
    const payloads = buildTaskletResearchPayloads(history, 1, PARTICIPANT, SUBMITTED_AT);
    assert.equal(payloads.length, 2);
    const ids = payloads.map(p => p.tasklet_id).sort();
    assert.deepEqual(ids, ["tasklet-a", "tasklet-b"]);
  });

  test("has_build is false and plan_prompt_count reflects a plan-only Tasklet", () => {
    const messages: TaskletMessage[] = [
      { stage: "plan", type: "prompt", model: "anthropic/claude-sonnet-4-6", message: "Plan A" },
      { stage: "plan", type: "response", model: "anthropic/claude-sonnet-4-6", message: "Response A" },
      { stage: "plan", type: "prompt", model: "anthropic/claude-sonnet-4-6", message: "Plan B" },
      { stage: "plan", type: "response", model: "anthropic/claude-sonnet-4-6", message: "Response B" },
    ];
    const history = makeHistory([
      { path: "src/app.ts", tasklets: [makeTasklet({ messages, buildCompletedAt: null })] },
    ]);
    const payloads = buildTaskletResearchPayloads(history, 1, PARTICIPANT, SUBMITTED_AT);
    assert.equal(payloads[0].plan_prompt_count, 2);
    assert.equal(payloads[0].has_build, false);
  });

  test("bleu_score averages only non-null per-hunk scores", () => {
    const history = makeHistory([
      {
        path: "src/app.ts",
        tasklets: [
          makeTasklet({
            diffHunks: [
              { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, isSignificant: true, bleuScore: 0.4 },
              { oldStart: 5, oldCount: 0, newStart: 5, newCount: 2, isSignificant: true, bleuScore: null },
              { oldStart: 10, oldCount: 1, newStart: 12, newCount: 1, isSignificant: false, bleuScore: 0.8 },
            ],
          }),
        ],
      },
    ]);
    const payloads = buildTaskletResearchPayloads(history, 1, PARTICIPANT, SUBMITTED_AT);
    assert.ok(Math.abs((payloads[0].bleu_score ?? NaN) - 0.6) < 1e-9); // (0.4 + 0.8) / 2
  });

  test("bleu_score is null when no hunk has a score", () => {
    const history = makeHistory([
      {
        path: "src/app.ts",
        tasklets: [
          makeTasklet({
            diffHunks: [
              { oldStart: 1, oldCount: 0, newStart: 1, newCount: 1, isSignificant: true, bleuScore: null },
            ],
          }),
        ],
      },
    ]);
    const payloads = buildTaskletResearchPayloads(history, 1, PARTICIPANT, SUBMITTED_AT);
    assert.equal(payloads[0].bleu_score, null);
  });

  test("review_latency_sec is computed from commit date minus build completion", () => {
    const history = makeHistory([
      {
        path: "src/app.ts",
        tasklets: [
          makeTasklet({
            buildCompletedAt: 1_753_350_000_000,
            originCommitCommitterDate: new Date(1_753_350_000_000 + 90_000).toISOString(),
          }),
        ],
      },
    ]);
    const payloads = buildTaskletResearchPayloads(history, 1, PARTICIPANT, SUBMITTED_AT);
    assert.equal(payloads[0].review_latency_sec, 90);
  });

  test("review_latency_sec is null for an uncommitted Tasklet", () => {
    const history = makeHistory([
      {
        path: "src/app.ts",
        tasklets: [
          makeTasklet({
            originCommitHash: undefined,
            originCommitAuthorDate: undefined,
            originCommitCommitterDate: undefined,
          }),
        ],
      },
    ]);
    const payloads = buildTaskletResearchPayloads(history, 1, PARTICIPANT, SUBMITTED_AT);
    assert.equal(payloads[0].review_latency_sec, null);
  });

  describe("generated_at fallback cascade", () => {
    test("uses taskletGeneratedAt when present", () => {
      const history = makeHistory([
        { path: "src/app.ts", tasklets: [makeTasklet({ taskletGeneratedAt: 1_000_000_000_000 })] },
      ]);
      const payloads = buildTaskletResearchPayloads(history, 1, PARTICIPANT, SUBMITTED_AT);
      assert.equal(payloads[0].generated_at, new Date(1_000_000_000_000).toISOString());
    });

    test("falls back to buildCompletedAt when taskletGeneratedAt is missing", () => {
      const history = makeHistory([
        {
          path: "src/app.ts",
          tasklets: [makeTasklet({ taskletGeneratedAt: null, buildCompletedAt: 2_000_000_000_000 })],
        },
      ]);
      const payloads = buildTaskletResearchPayloads(history, 1, PARTICIPANT, SUBMITTED_AT);
      assert.equal(payloads[0].generated_at, new Date(2_000_000_000_000).toISOString());
    });

    test("falls back to originCommitAuthorDate when both timestamps are missing", () => {
      const history = makeHistory([
        {
          path: "src/app.ts",
          tasklets: [
            makeTasklet({
              taskletGeneratedAt: null,
              buildCompletedAt: null,
              originCommitAuthorDate: "2026-01-01T00:00:00.000Z",
            }),
          ],
        },
      ]);
      const payloads = buildTaskletResearchPayloads(history, 1, PARTICIPANT, SUBMITTED_AT);
      assert.equal(payloads[0].generated_at, "2026-01-01T00:00:00.000Z");
    });

    test("drops the Tasklet entirely when no timestamp is available at all", () => {
      const history = makeHistory([
        {
          path: "src/app.ts",
          tasklets: [
            makeTasklet({
              taskletGeneratedAt: null,
              buildCompletedAt: null,
              originCommitAuthorDate: undefined,
            }),
          ],
        },
      ]);
      const payloads = buildTaskletResearchPayloads(history, 1, PARTICIPANT, SUBMITTED_AT);
      assert.equal(payloads.length, 0);
    });
  });

  describe("Tier 2 fields", () => {
    test("redacts fenced code blocks in plan/build responses", () => {
      const messages: TaskletMessage[] = [
        { stage: "plan", type: "prompt", model: "anthropic/claude-sonnet-4-6", message: "Plan this" },
        {
          stage: "plan", type: "response", model: "anthropic/claude-sonnet-4-6",
          message: "Here's the plan.\n\n```python\nprint('secret')\n```\n\nDone.",
        },
        { stage: "build", type: "prompt", model: "anthropic/claude-sonnet-4-6", message: "Build it" },
        {
          stage: "build", type: "response", model: "anthropic/claude-sonnet-4-6",
          message: "Done.\n\n```ts\nconst x = 1;\n```",
        },
      ];
      const history = makeHistory([{ path: "src/app.ts", tasklets: [makeTasklet({ messages })] }]);
      const payloads = buildTaskletResearchPayloads(history, 2, PARTICIPANT, SUBMITTED_AT) as Tier2Payload[];

      assert.equal(payloads[0].plan_responses[0], "Here's the plan.\n\n[code omitted]\n\nDone.");
      assert.equal(payloads[0].build_response, "Done.\n\n[code omitted]");
      assert.ok(!payloads[0].plan_responses[0].includes("secret"));
      assert.ok(!payloads[0].build_response.includes("const x"));
    });

    test("extracts structured questions_answers independent of message text", () => {
      const history = makeHistory([
        {
          path: "src/app.ts",
          tasklets: [
            makeTasklet({
              questions: [
                {
                  question: "Which log level?",
                  header: "Log level",
                  options: [{ label: "DEBUG", description: "verbose" }],
                  answer: ["DEBUG"],
                  outputId: "build_1",
                },
              ],
            }),
          ],
        },
      ]);
      const payloads = buildTaskletResearchPayloads(history, 2, PARTICIPANT, SUBMITTED_AT) as Tier2Payload[];
      assert.deepEqual(payloads[0].questions_answers, [{ question: "Which log level?", answer: ["DEBUG"] }]);
    });

    test("Tier 2 payload does not include Tier 3 diff_hunks", () => {
      const history = makeHistory([{ path: "src/app.ts", tasklets: [makeTasklet()] }]);
      const payloads = buildTaskletResearchPayloads(history, 2, PARTICIPANT, SUBMITTED_AT);
      assert.equal("diff_hunks" in payloads[0], false);
    });
  });

  describe("Tier 3 fields", () => {
    test("flattens diff_hunks across files with correct file tagging and field mapping", () => {
      const history = makeHistory([
        {
          path: "src/app.ts",
          tasklets: [
            makeTasklet({
              diffHunks: [
                {
                  oldStart: 2, oldCount: 1, newStart: 2, newCount: 1,
                  isSignificant: true, bleuScore: 0.4,
                  addedLines: ["new line"], removedLines: ["old line"],
                },
              ],
            }),
          ],
        },
        {
          path: "src/helper.py",
          tasklets: [
            makeTasklet({
              diffHunks: [
                {
                  oldStart: 0, oldCount: 0, newStart: 1, newCount: 2,
                  isSignificant: false, bleuScore: null,
                  addedLines: ["a", "b"], removedLines: [],
                },
              ],
            }),
          ],
        },
      ]);
      const payloads = buildTaskletResearchPayloads(history, 3, PARTICIPANT, SUBMITTED_AT) as Tier3Payload[];
      const p = payloads[0];

      assert.equal(p.diff_hunks.length, 2);
      const appHunk = p.diff_hunks.find(h => h.file === "src/app.ts");
      const helperHunk = p.diff_hunks.find(h => h.file === "src/helper.py");
      assert.ok(appHunk);
      assert.ok(helperHunk);
      assert.equal(appHunk!.old_start, 2);
      assert.equal(appHunk!.old_count, 1);
      assert.equal(appHunk!.new_start, 2);
      assert.equal(appHunk!.new_count, 1);
      assert.deepEqual(appHunk!.added_lines, ["new line"]);
      assert.deepEqual(appHunk!.removed_lines, ["old line"]);
      assert.deepEqual(helperHunk!.added_lines, ["a", "b"]);

      // hunk_significance is index-aligned with diff_hunks, all hunks included
      // (not just BLEU-significant ones)
      assert.equal(p.hunk_significance.length, 2);
      const appIndex = p.diff_hunks.indexOf(appHunk!);
      const helperIndex = p.diff_hunks.indexOf(helperHunk!);
      assert.equal(p.hunk_significance[appIndex], true);
      assert.equal(p.hunk_significance[helperIndex], false);
    });

    test("defaults missing addedLines/removedLines/isSignificant to safe values", () => {
      const history = makeHistory([
        {
          path: "src/app.ts",
          tasklets: [
            makeTasklet({
              diffHunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }],
            }),
          ],
        },
      ]);
      const payloads = buildTaskletResearchPayloads(history, 3, PARTICIPANT, SUBMITTED_AT) as Tier3Payload[];
      assert.deepEqual(payloads[0].diff_hunks[0].added_lines, []);
      assert.deepEqual(payloads[0].diff_hunks[0].removed_lines, []);
      assert.equal(payloads[0].hunk_significance[0], false);
    });

    test("Tier 3 still includes Tier 2 fields", () => {
      const history = makeHistory([{ path: "src/app.ts", tasklets: [makeTasklet()] }]);
      const payloads = buildTaskletResearchPayloads(history, 3, PARTICIPANT, SUBMITTED_AT) as Tier3Payload[];
      assert.ok(Array.isArray(payloads[0].plan_prompts));
      assert.ok(Array.isArray(payloads[0].questions_answers));
    });
  });

  test("model_provider/model_id split on the build-stage message's model field", () => {
    const messages: TaskletMessage[] = [
      { stage: "build", type: "prompt", model: "openai/gpt-5", message: "Build it" },
      { stage: "build", type: "response", model: "openai/gpt-5", message: "Done" },
    ];
    const history = makeHistory([{ path: "src/app.ts", tasklets: [makeTasklet({ messages })] }]);
    const payloads = buildTaskletResearchPayloads(history, 1, PARTICIPANT, SUBMITTED_AT);
    assert.equal(payloads[0].model_provider, "openai");
    assert.equal(payloads[0].model_id, "gpt-5");
  });

  test("agent_source is threaded through for a claude-code Tasklet", () => {
    const history = makeHistory([{ path: "src/app.ts", tasklets: [makeTasklet({ agentSource: "claude-code" })] }]);
    const payloads = buildTaskletResearchPayloads(history, 1, PARTICIPANT, SUBMITTED_AT);
    assert.equal(payloads[0].agent_source, "claude-code");
  });

  test("agent_source is threaded through for a codex Tasklet", () => {
    const history = makeHistory([{ path: "src/app.ts", tasklets: [makeTasklet({ agentSource: "codex" })] }]);
    const payloads = buildTaskletResearchPayloads(history, 1, PARTICIPANT, SUBMITTED_AT);
    assert.equal(payloads[0].agent_source, "codex");
  });

  test("agent_source defaults to opencode when missing (pre-existing cached History)", () => {
    const history = makeHistory([{ path: "src/app.ts", tasklets: [makeTasklet({ agentSource: undefined })] }]);
    const payloads = buildTaskletResearchPayloads(history, 1, PARTICIPANT, SUBMITTED_AT);
    assert.equal(payloads[0].agent_source, "opencode");
  });

  test("empty history produces no payloads", () => {
    const payloads = buildTaskletResearchPayloads(makeHistory([]), 1, PARTICIPANT, SUBMITTED_AT);
    assert.deepEqual(payloads, []);
  });
});
