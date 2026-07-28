import { z } from "zod";

// Mirrors vscode-extension/src/research/types.ts's TaskletResearchPayload.
// Kept as a separate copy rather than a shared package — the two sides
// deploy independently, and schema drift here should fail loudly (a rejected
// submission) rather than silently coupling two deploys together.

const basePayload = z.object({
  participant_id: z.string().min(1),
  tasklet_id: z.string().min(1),
  session_id: z.string(),
  agent_source: z.enum(["opencode", "claude-code", "codex"]),
  repo_url: z.string().nullable(),
  generated_at: z.string(),
  submitted_at: z.string(),

  model_provider: z.string(),
  model_id: z.string(),

  plan_prompt_count: z.number(),
  has_build: z.boolean(),

  files_touched_ext: z.array(z.string()),
  files_touched_count: z.number(),
  lines_changed_total: z.number(),

  ownership_flip: z.boolean(),
  bleu_score: z.number().nullable(),
  review_latency_sec: z.number().nullable(),
});

const tier1Payload = basePayload.extend({ consent_level: z.literal(1) });

const tier2Fields = {
  plan_prompts: z.array(z.string()),
  plan_responses: z.array(z.string()),
  build_prompt: z.string(),
  build_response: z.string(),
  questions_answers: z.array(z.object({ question: z.string(), answer: z.array(z.string()) })),
};

const tier2Payload = basePayload.extend({ consent_level: z.literal(2), ...tier2Fields });

const diffHunk = z.object({
  file: z.string(),
  old_start: z.number(),
  old_count: z.number(),
  new_start: z.number(),
  new_count: z.number(),
  added_lines: z.array(z.string()),
  removed_lines: z.array(z.string()),
});

const tier3Payload = basePayload.extend({
  consent_level: z.literal(3),
  ...tier2Fields,
  diff_hunks: z.array(diffHunk),
  hunk_significance: z.array(z.boolean()),
});

export const taskletResearchPayloadSchema = z.discriminatedUnion("consent_level", [
  tier1Payload,
  tier2Payload,
  tier3Payload,
]);

export type TaskletResearchPayload = z.infer<typeof taskletResearchPayloadSchema>;

export const submitRequestSchema = z.object({
  payloads: z.array(taskletResearchPayloadSchema).min(1).max(200),
});
