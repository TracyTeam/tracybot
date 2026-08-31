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
  agentSource: "opencode" | "claude-code" | "codex";
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

// path -> line -> the taskletId that currently, live-ly owns that line.
// history.files[path].tasklets is chronological (oldest -> newest), so
// whichever entry lists a line in its (live) `lines` last is the current
// owner — ghostLines never contribute here, by definition.
function buildLineOwnership(history: History): Map<string, Map<number, string>> {
  const ownership = new Map<string, Map<number, string>>();

  for (const file of history.files) {
    const lineOwner = new Map<number, string>();
    for (const tasklet of file.tasklets) {
      if (!tasklet.taskletId) { continue; }
      for (const line of tasklet.lines) {
        lineOwner.set(line, tasklet.taskletId);
      }
    }
    ownership.set(file.path, lineOwner);
  }

  return ownership;
}

// path -> line -> chronological, deduped list of taskletIds that touched
// that line (live or ghost) but are not its current owner — i.e. the
// "previous Tasklets for this line" the AI Blame panel shows, keyed by
// taskletId instead of the per-file snapshot id so it lines up with the
// tasklet_id already in the payload.
function buildLineHistory(history: History, ownership: Map<string, Map<number, string>>): Map<string, Map<number, string[]>> {
  const history_ = new Map<string, Map<number, string[]>>();

  for (const file of history.files) {
    const lineOwner = ownership.get(file.path)!;
    const lineHistory = new Map<number, string[]>();

    for (const tasklet of file.tasklets) {
      if (!tasklet.taskletId) { continue; }

      // Unlike the AI Blame panel's dropdown, a Tasklet that's since been
      // fully overridden (no live lines left anywhere) still belongs in the
      // history — it's exactly the rewrite-chain data this field exists for.
      const touched = new Set<number>([...tasklet.lines, ...tasklet.ghostLines]);
      for (const line of touched) {
        if (lineOwner.get(line) === tasklet.taskletId) { continue; }

        const ids = lineHistory.get(line) ?? [];
        if (!ids.includes(tasklet.taskletId)) { ids.push(tasklet.taskletId); }
        lineHistory.set(line, ids);
      }
    }

    history_.set(file.path, lineHistory);
  }

  return history_;
}

// For each line this Tasklet currently (live-ly) owns, who wrote it before —
// deduped across all its files/lines, in roughly chronological order.
function buildHistoryTaskletIds(group: TaskletGroup, lineHistory: Map<string, Map<number, string[]>>): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];

  for (const f of group.files) {
    const fileHistory = lineHistory.get(f.path);
    if (!fileHistory) { continue; }

    for (const line of f.lines) {
      for (const id of fileHistory.get(line) ?? []) {
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }
  }

  return ids;
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

// Agents often reference files with markdown links or plain paths, e.g.
// "I edited [utils.ts](/Users/esme/projects/secret-client/src/utils.ts)" —
// an absolute path rooted in a home directory leaks the participant's
// username and local project/directory names, neither of which
// redactFencedCode catches since this text sits outside any code fence.
// Scoped to home-directory-style paths (not every "/" in the text) so it
// doesn't also mangle unrelated content like URLs or in-repo relative paths.
const HOME_DIR_PATH_RE = /(?<![\w.:/\\])(?:\/Users\/|\/home\/|~\/|[A-Za-z]:\\Users\\)[^\s)\]`"']+/g;

// Trailing sentence punctuation (". "/", "/etc.) is a valid path character as
// far as the regex is concerned, so a match like "config.json." would
// otherwise swallow the full stop ending the sentence. Strip it back off
// and keep it outside the placeholder.
function redactFilePaths(text: string): string {
  return text.replace(HOME_DIR_PATH_RE, match => {
    const path = match.replace(/[.,;:!?]+$/, "");
    return "<path omitted>" + match.slice(path.length);
  });
}

function redactSensitiveText(text: string): string {
  return redactFilePaths(redactFencedCode(text));
}

function messagesByStage(messages: TaskletMessage[], stage: "plan" | "build", type: "prompt" | "response"): string[] {
  return messages.filter(m => m.stage === stage && m.type === type).map(m => m.message);
}

function buildBasePayload(
  group: TaskletGroup,
  participant: ParticipantContext,
  submittedAt: string,
  lineHistory: Map<string, Map<number, string[]>>
): BaseTaskletPayload | null {
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
    history_tasklet_ids: buildHistoryTaskletIds(group, lineHistory),
  };
}

export function buildTaskletResearchPayloads(
  history: History,
  consentTier: 1 | 2,
  participant: ParticipantContext,
  submittedAt: string = new Date().toISOString()
): TaskletResearchPayload[] {
  const groups = groupByTasklet(history);
  const lineHistory = buildLineHistory(history, buildLineOwnership(history));
  const payloads: TaskletResearchPayload[] = [];

  for (const group of groups) {
    const base = buildBasePayload(group, participant, submittedAt, lineHistory);
    if (!base) {
      continue;
    }

    const tier1Fields = {
      plan_prompts: messagesByStage(group.messages, "plan", "prompt").map(redactSensitiveText),
      plan_responses: messagesByStage(group.messages, "plan", "response").map(redactSensitiveText),
      build_prompt: redactSensitiveText(messagesByStage(group.messages, "build", "prompt")[0] ?? ""),
      build_response: redactSensitiveText(messagesByStage(group.messages, "build", "response")[0] ?? ""),
      questions_answers: group.questions.map(q => ({
        question: redactSensitiveText(q.question),
        answer: q.answer.map(redactSensitiveText),
      })),
    };

    if (consentTier === 1) {
      payloads.push({ ...base, ...tier1Fields, consent_level: 1 });
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
      ...tier1Fields,
      consent_level: 2,
      diff_hunks: diffHunks,
      hunk_significance: hunkSignificance,
    });
  }

  return payloads;
}
