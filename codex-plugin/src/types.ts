// Same rationale as claude-code-plugin's ClaudeTurn — Codex CLI has no
// Plan/Build split either, so this is a flat record of one turn
// (one PostToolUse-flagged edit through Stop), not OpenCode's Tasklet shape.
export interface CodexTurn {
  id: string
  sessionId: string
  source: "codex"
  model?: string
  prompt: string
  response: string
  promptCreatedAt: number
  responseCompletedAt: number
}

// Unlike Claude Code's PostToolUse (which gives a clean tool_input.file_path
// for Edit/Write), Codex's apply_patch tool reports the change via
// tool_input.command — patch/command text, not a single file path. Rather
// than parse an unconfirmed patch format, this only tracks *whether* an edit
// happened this turn, which is all the gating logic (mirroring OpenCode's
// toolCount > 0) actually needs.
//
// repoRoot is resolved from the hook's cwd at PostToolUse time (right when
// the edit happens) and reused as-is at Stop, rather than re-resolving cwd
// at Stop time — a session's shell cwd can drift after the edit (e.g. a
// later, unrelated `cd` into a different repo to run some diagnostic
// command), and Stop firing with that drifted cwd would snapshot the wrong
// repo entirely.
export interface PendingTurnState {
  edited: boolean
  repoRoot?: string
}
