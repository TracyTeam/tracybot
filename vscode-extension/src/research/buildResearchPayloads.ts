import * as path from "path";
import { History, TaskletMessage, TaskletQuestion, DiffHunk } from "../history/types";
import {
  BaseTaskletPayload,
  ParticipantContext,
  ResearchDiffHunk,
  TaskletResearchPayload,
} from "./types";

interface TaskletGroup {
  key: string;
  taskletId: string;
  sessionId?: string;
  agentSource: "opencode" | "claude-code";
  messages: TaskletMessage[];
  questions: TaskletQuestion[];
  taskletGeneratedAt: number | null;
  buildCompletedAt: number | null;
  originCommitAuthorDate?: string;
  originCommitCommitterDate?: string;
  files: { path: string; lines: number[]; ghostLines: number[]; diffHunks: DiffHunk[] }[];
}

// Groups history.files[].tasklets[] (grouped by file) into one entry per Tasklet.
// A single Tasklet's records are scattered across every file it touched, sharing
// the same taskletId — the file grouping buildHistory() produces is the wrong
// shape for a per-Tasklet payload.
//
// Tasklets missing a taskletId (pre-dating the Research Mode fields, e.g. old
// cached workspaceState data, or a non-JSON tasklet description) are skipped —
// there's no reliable identity to build a payload around.
function groupByTasklet(history: History): TaskletGroup[] {
  const groups = new Map<string, TaskletGroup>();

  for (const file of history.files) {
    for (const tasklet of file.tasklets) {
      if (!tasklet.taskletId) {
        continue;
      }

      let group = groups.get(tasklet.taskletId);
      if (!group) {
        group = {
          key: tasklet.taskletId,
          taskletId: tasklet.taskletId,
          sessionId: tasklet.sessionId,
          // Defaults to "opencode" for cached History built before agentSource
          // existed — the only agent that could have produced it back then.
          agentSource: tasklet.agentSource ?? "opencode",
          messages: tasklet.messages,
          questions: tasklet.questions ?? [],
          taskletGeneratedAt: tasklet.taskletGeneratedAt ?? null,
          buildCompletedAt: tasklet.buildCompletedAt ?? null,
          originCommitAuthorDate: tasklet.originCommitAuthorDate,
          originCommitCommitterDate: tasklet.originCommitCommitterDate,
          files: [],
        };
        groups.set(tasklet.taskletId, group);
      }

      group.files.push({
        path: file.path,
        lines: tasklet.lines,
        ghostLines: tasklet.ghostLines,
        diffHunks: tasklet.diffHunks ?? [],
      });
    }
  }

  return Array.from(groups.values());
}

// The build-stage prompt carries the model that actually produced the code;
// falls back to any message with a model set (e.g. plan-only Tasklets).
function splitModel(messages: TaskletMessage[]): { provider: string; modelId: string } {
  const buildPrompt = messages.find(m => m.stage === "build" && m.type === "prompt" && m.model);
  const formatted = buildPrompt?.model ?? messages.find(m => m.model)?.model ?? "";
  const slashIndex = formatted.indexOf("/");

  if (slashIndex === -1) {
    return { provider: "", modelId: formatted };
  }

  return { provider: formatted.slice(0, slashIndex), modelId: formatted.slice(slashIndex + 1) };
}

function averageBleuScore(files: TaskletGroup["files"]): number | null {
  const scores = files
    .flatMap(f => f.diffHunks)
    .map(h => h.bleuScore)
    .filter((score): score is number => score !== null && score !== undefined);

  if (scores.length === 0) {
    return null;
  }

  return scores.reduce((sum, s) => sum + s, 0) / scores.length;
}

function reviewLatencySec(group: TaskletGroup): number | null {
  if (!group.originCommitCommitterDate || group.buildCompletedAt === null) {
    return null;
  }

  const committedAt = new Date(group.originCommitCommitterDate).getTime();
  return (committedAt - group.buildCompletedAt) / 1000;
}

// Falls back through the timestamps we have, in order of accuracy, so a
// Tasklet is never dropped just because one particular timestamp is missing.
function generatedAtIso(group: TaskletGroup): string | null {
  if (group.taskletGeneratedAt !== null) {
    return new Date(group.taskletGeneratedAt).toISOString();
  }

  if (group.buildCompletedAt !== null) {
    return new Date(group.buildCompletedAt).toISOString();
  }

  return group.originCommitAuthorDate ?? null;
}

function redactFencedCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "[code omitted]");
}

function messagesByStage(messages: TaskletMessage[], stage: "plan" | "build", type: "prompt" | "response"): string[] {
  return messages.filter(m => m.stage === stage && m.type === type).map(m => m.message);
}

function buildBasePayload(group: TaskletGroup, participant: ParticipantContext, submittedAt: string): BaseTaskletPayload | null {
  const generatedAt = generatedAtIso(group);
  if (generatedAt === null) {
    return null;
  }

  const { provider, modelId } = splitModel(group.messages);
  const uniquePaths = Array.from(new Set(group.files.map(f => f.path)));
  const extensions = Array.from(new Set(uniquePaths.map(p => path.extname(p))));

  return {
    participant_id: participant.participantId,
    tasklet_id: group.taskletId,
    session_id: group.sessionId ?? "",
    agent_source: group.agentSource,
    repo_url: participant.repoUrl,
    generated_at: generatedAt,
    submitted_at: submittedAt,

    model_provider: provider,
    model_id: modelId,

    plan_prompt_count: messagesByStage(group.messages, "plan", "prompt").length,
    has_build: group.messages.some(m => m.stage === "build"),

    files_touched_ext: extensions,
    files_touched_count: uniquePaths.length,
    lines_changed_total: group.files.reduce((sum, f) => sum + f.lines.length + f.ghostLines.length, 0),

    ownership_flip: group.files.some(f => f.ghostLines.length > 0),
    bleu_score: averageBleuScore(group.files),
    review_latency_sec: reviewLatencySec(group),
  };
}

export function buildTaskletResearchPayloads(
  history: History,
  consentTier: 1 | 2 | 3,
  participant: ParticipantContext,
  submittedAt: string = new Date().toISOString()
): TaskletResearchPayload[] {
  const groups = groupByTasklet(history);
  const payloads: TaskletResearchPayload[] = [];

  for (const group of groups) {
    const base = buildBasePayload(group, participant, submittedAt);
    if (!base) {
      continue;
    }

    if (consentTier === 1) {
      payloads.push({ ...base, consent_level: 1 });
      continue;
    }

    const tier2Fields = {
      plan_prompts: messagesByStage(group.messages, "plan", "prompt").map(redactFencedCode),
      plan_responses: messagesByStage(group.messages, "plan", "response").map(redactFencedCode),
      build_prompt: redactFencedCode(messagesByStage(group.messages, "build", "prompt")[0] ?? ""),
      build_response: redactFencedCode(messagesByStage(group.messages, "build", "response")[0] ?? ""),
      questions_answers: group.questions.map(q => ({ question: q.question, answer: q.answer })),
    };

    if (consentTier === 2) {
      payloads.push({ ...base, ...tier2Fields, consent_level: 2 });
      continue;
    }

    const diffHunks: ResearchDiffHunk[] = group.files.flatMap(f =>
      f.diffHunks.map(h => ({
        file: f.path,
        old_start: h.oldStart,
        old_count: h.oldCount,
        new_start: h.newStart,
        new_count: h.newCount,
        added_lines: h.addedLines ?? [],
        removed_lines: h.removedLines ?? [],
      }))
    );
    const hunkSignificance = group.files.flatMap(f => f.diffHunks.map(h => h.isSignificant ?? false));

    payloads.push({
      ...base,
      ...tier2Fields,
      consent_level: 3,
      diff_hunks: diffHunks,
      hunk_significance: hunkSignificance,
    });
  }

  return payloads;
}
