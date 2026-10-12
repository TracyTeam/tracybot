// Claude Code has no Plan/Build mode distinction the way OpenCode does, so
// this is intentionally not shaped like opencode-plugin's Tasklet — it's a
// flat record of one turn (one UserPromptSubmit -> Stop cycle) that actually
// changed the repo (via Edit/Write/MultiEdit, or a Bash command such as
// sed). buildHistory.ts's parser uses `source` to tell the two shapes apart.
export interface ClaudeTurn {
  id: string
  sessionId: string
  source: "claude-code"
  model?: string
  prompt: string
  response: string
  promptCreatedAt: number
  responseCompletedAt: number
  // Earlier turns of the session that didn't edit any file (e.g. a
  // discussion that ended in "yes, do it"), oldest first — shown as the
  // Plan stage so the recorded intent isn't just a short approval prompt.
  context?: ContextTurn[]
}

export interface ContextTurn {
  prompt: string
  response: string
}

// Stashed between hooks for a single in-flight turn — PostToolUse appends to
// editedFiles, Stop reads + deletes it. Only tracks "did an edit happen",
// not prompt text — the prompt/response text itself is read from the
// transcript + last_assistant_message at Stop time instead (see stop.ts),
// since UserPromptSubmit's JSON input isn't confirmed to carry prompt text.
export interface PendingTurnState {
  editedFiles: string[]
  // Working directories Bash ran in this turn. A shell command can change
  // files without naming them (e.g. `sed -i`), so these only mark which
  // repo might have changed; tracy.py decides whether anything actually did.
  bashCwds?: string[]
}
