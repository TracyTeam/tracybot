import { markEdited, readPendingTurn, clearPendingTurn } from "./state"
import { extractLastUserPrompt } from "./transcript"
import { getRepoRoot, resolveTracyPath, detectPythonCommand, runTracySnapshot } from "./tracy"
import type { CodexTurn } from "./types"

// "apply_patch" is Codex's actual file-edit tool; "Edit"/"Write" are kept as
// fallbacks since the hooks reference notes these are usable as matcher
// aliases, implying tool_name could plausibly surface as either depending on
// configuration — unverified against a real session, cheap to keep both.
const EDIT_TOOLS = new Set(["apply_patch", "Edit", "Write"])

interface ToolEventInput {
    session_id: string
    cwd: string
    tool_name?: string
}

interface StopEventInput {
    session_id: string
    cwd: string
    transcript_path: string
    last_assistant_message?: string
    model?: string
}

async function readStdinJson<T>(): Promise<T> {
    const text = await Bun.stdin.text()
    return JSON.parse(text) as T
}

async function handlePostToolUse(): Promise<void> {
    const input = await readStdinJson<ToolEventInput>()
    if (!input.tool_name || !EDIT_TOOLS.has(input.tool_name)) return

    await markEdited(input.session_id)
}

async function handleStop(): Promise<void> {
    const input = await readStdinJson<StopEventInput>()

    const pending = await readPendingTurn(input.session_id)
    if (!pending?.edited) return // nothing edited this turn — mirrors OpenCode's toolCount > 0 gate

    const repoRoot = await getRepoRoot(input.cwd)
    if (!repoRoot) return

    const tracyPath = await resolveTracyPath(repoRoot)
    if (!tracyPath) return // Tracybot not initialized in this repo

    const pythonCmd = await detectPythonCommand()
    if (!pythonCmd) return

    const now = Date.now()
    const turn: CodexTurn = {
        id: `codex_${input.session_id}_${now}`,
        sessionId: input.session_id,
        source: "codex",
        // Codex's hook input carries `model` directly, unlike Claude Code —
        // no transcript parsing needed for this part.
        model: input.model ? `openai/${input.model}` : undefined,
        prompt: await extractLastUserPrompt(input.transcript_path),
        response: input.last_assistant_message ?? "",
        promptCreatedAt: now, // no reliable original-prompt timestamp available — best approximation
        responseCompletedAt: now,
    }

    await runTracySnapshot(pythonCmd, tracyPath, repoRoot, JSON.stringify(turn), input.session_id)
    await clearPendingTurn(input.session_id)
}

async function main(): Promise<void> {
    const event = process.argv[2]

    try {
        if (event === "post-tool-use") {
            await handlePostToolUse()
        } else if (event === "stop") {
            await handleStop()
        }
    } catch {
        // Hooks must never break the user's Codex session — swallow and
        // exit cleanly, same rationale as claude-code-plugin.
    }
}

await main()
