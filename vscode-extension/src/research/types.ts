export type ISODateString = string; // e.g. "2026-07-22T14:30:00Z"

export interface BaseTaskletPayload {
  participant_id: string;      // pseudonymous, generated locally on opt-in
  tasklet_id: string;
  session_id: string;
  agent_source: "opencode" | "claude-code";
  repo_url: string | null;     // only if participant opts to share it
  generated_at: ISODateString; // Tasklet creation time (first prompt)
  submitted_at: ISODateString; // when it left the participant's machine

  model_provider: string;      // e.g. "anthropic"
  model_id: string;            // e.g. "claude-sonnet-4-6"

  plan_prompt_count: number;
  has_build: boolean;

  files_touched_ext: string[]; // extensions only, e.g. [".ts", ".tsx"] — never full paths
  files_touched_count: number;
  lines_changed_total: number; // lines.length + ghostLines.length, summed across files

  ownership_flip: boolean;     // true if any Change in this Tasklet has ghostLines
  bleu_score: number | null;   // summary: average of non-null per-hunk BLEU scores; null if none apply
  review_latency_sec: number | null; // null until the Tasklet's snapshot has been committed
}

export interface Tier1Payload extends BaseTaskletPayload {
  consent_level: 1;
}

interface Tier2Fields {
  plan_prompts: string[];
  plan_responses: string[];   // fenced code blocks replaced with "[code omitted]"
  build_prompt: string;
  build_response: string;     // same redaction applied
  questions_answers: { question: string; answer: string[] }[];
}

export interface Tier2Payload extends BaseTaskletPayload, Tier2Fields {
  consent_level: 2;
}

export interface ResearchDiffHunk {
  file: string;
  old_start: number;
  old_count: number;
  new_start: number;
  new_count: number;
  added_lines: string[];
  removed_lines: string[];
}

export interface Tier3Payload extends BaseTaskletPayload, Tier2Fields {
  consent_level: 3;
  diff_hunks: ResearchDiffHunk[];        // every hunk touched by this Tasklet, never a full file/repo snapshot
  hunk_significance: boolean[];  // BLEU-threshold result per hunk, same index order as diff_hunks
}

export type TaskletResearchPayload = Tier1Payload | Tier2Payload | Tier3Payload;

export interface ParticipantContext {
  participantId: string;
  repoUrl: string | null;
}
