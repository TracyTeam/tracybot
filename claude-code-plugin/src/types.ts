// Claude Code has no Plan/Build mode distinction the way OpenCode does, so
// this is intentionally not shaped like opencode-plugin's Tasklet — it's a
// flat record of one turn (one UserPromptSubmit -> Stop cycle) that actually
// touched a file via Edit/Write/MultiEdit. buildHistory.ts's parser uses
// `source` to tell the two shapes apart.
export interface ClaudeTurn {
  id: string
  sessionId: string
  source: "claude-code"
  model?: string
  prompt: string
  response: string
  promptCreatedAt: number
  responseCompletedAt: number
}

// Stashed between hooks for a single in-flight turn — PostToolUse appends to
// editedFiles, Stop reads + deletes it. Only tracks "did an edit happen",
// not prompt text — the prompt/response text itself is read from the
// transcript + last_assistant_message at Stop time instead (see stop.ts),
// since UserPromptSubmit's JSON input isn't confirmed to carry prompt text.
export interface PendingTurnState {
  editedFiles: string[]
}
