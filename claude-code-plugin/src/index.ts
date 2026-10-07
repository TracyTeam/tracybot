import { markFileEdited, markBashRan, readPendingTurn, clearPendingTurn, appendContextTurn, readContextTurns, clearContextTurns } from "./state"
import { extractTurnContext } from "./transcript"
import { getRepoRootForEditedFiles, getFirstRepoRoot, getLatestSnapshot, resolveTracyPath, detectPythonCommand, runTracySnapshot } from "./tracy"
import type { ClaudeTurn, PendingTurnState } from "./types"

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"])

interface ToolEventInput {
    session_id: string
    cwd: string
    tool_name?: string
    tool_input?: { file_path?: string }
}

interface StopEventInput {
    session_id: string
    cwd: string
    transcript_path: string
    last_assistant_message?: string
}

async function readStdinJson<T>(): Promise<T> {
    const text = await Bun.stdin.text()
    return JSON.parse(text) as T
}

async function handlePostToolUse(): Promise<void> {
    const input = await readStdinJson<ToolEventInput>()
    if (input.tool_name === "Bash") {
        await markBashRan(input.session_id, input.cwd)
        return
    }
    if (!input.tool_name || !EDIT_TOOLS.has(input.tool_name)) return
    if (!input.tool_input?.file_path) return

    await markFileEdited(input.session_id, input.tool_input.file_path)
}

async function handleStop(): Promise<void> {
    const input = await readStdinJson<StopEventInput>()

    const pending = await readPendingTurn(input.session_id)
    await clearPendingTurn(input.session_id)

    const { prompt, model } = await extractTurnContext(input.transcript_path)
    const response = input.last_assistant_message ?? ""

    if (pending && await recordSnapshot(input.session_id, pending, prompt, model, response)) {
        await clearContextTurns(input.session_id)
    } else if (prompt && !pending?.editedFiles.length) {
        // Nothing changed this turn — mirrors OpenCode's toolCount > 0 gate,
        // but keep the turn as context for the next one that does change
        // something in the same repo. Where Bash ran is the better signal;
        // the Stop event's cwd is the fallback for a turn with no tool use.
        const repoRoot = await getFirstRepoRoot([...(pending?.bashCwds ?? []), input.cwd])
        if (repoRoot) {
            await appendContextTurn(input.session_id, repoRoot, { prompt, response })
        }
    }
}

// Returns whether tracy.py actually recorded a snapshot. It skips when the
// tree is unchanged, e.g. a turn whose Bash commands only read files.
async function recordSnapshot(sessionId: string, pending: PendingTurnState, prompt: string, model: string, response: string): Promise<boolean> {
    // Derived from the edited files, or where Bash ran, not the Stop event's
    // cwd — see getRepoRootForEditedFiles for why that can't be trusted.
    const repoRoot = (await getRepoRootForEditedFiles(pending.editedFiles))
        ?? (await getFirstRepoRoot(pending.bashCwds ?? []))
    if (!repoRoot) return false

    const tracyPath = await resolveTracyPath(repoRoot)
    if (!tracyPath) return false // Tracybot not initialized in this repo

    const pythonCmd = await detectPythonCommand()
    if (!pythonCmd) return false

    const now = Date.now()
    const turn: ClaudeTurn = {
        id: `claude_${sessionId}_${now}`,
        sessionId,
        source: "claude-code",
        // Claude Code's transcript only has the bare model id (e.g.
        // "claude-sonnet-5"), not an "anthropic/..." formatted string the
        // way OpenCode's SDK provides — Claude Code is Anthropic-only, so
        // prefixing here keeps model_provider/model_id splitting the same
        // way on the Research Mode side regardless of which agent produced a
        // given Tasklet.
        model: model ? `anthropic/${model}` : undefined,
        prompt,
        response,
        promptCreatedAt: now, // transcript doesn't reliably expose the original prompt timestamp — best available approximation
        responseCompletedAt: now,
        context: await readContextTurns(sessionId, repoRoot),
    }

    const before = await getLatestSnapshot(repoRoot)
    await runTracySnapshot(pythonCmd, tracyPath, repoRoot, JSON.stringify(turn), sessionId)
    return (await getLatestSnapshot(repoRoot)) !== before
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
        // Hooks must never break the user's Claude Code session — swallow
        // and exit cleanly. There's no client to log through here (unlike
        // OpenCode's plugin, which has L.error via the SDK client), so a
        // failure here is silent by design rather than noisy in a way that
        // could look like a Claude Code problem.
    }
}

await main()
