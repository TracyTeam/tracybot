import { markFileEdited, readPendingTurn, clearPendingTurn } from "./state"
import { extractTurnContext } from "./transcript"
import { getRepoRootForEditedFiles, resolveTracyPath, detectPythonCommand, runTracySnapshot } from "./tracy"
import type { ClaudeTurn } from "./types"

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
    if (!input.tool_name || !EDIT_TOOLS.has(input.tool_name)) return
    if (!input.tool_input?.file_path) return

    await markFileEdited(input.session_id, input.tool_input.file_path)
}

async function handleStop(): Promise<void> {
    const input = await readStdinJson<StopEventInput>()

    const pending = await readPendingTurn(input.session_id)
    if (!pending || pending.editedFiles.length === 0) return // nothing edited this turn — mirrors OpenCode's toolCount > 0 gate

    // Derived from the actual edited files, not input.cwd — see
    // getRepoRootForEditedFiles for why the hook's own cwd can't be trusted.
    const repoRoot = await getRepoRootForEditedFiles(pending.editedFiles)
    if (!repoRoot) return

    const tracyPath = await resolveTracyPath(repoRoot)
    if (!tracyPath) return // Tracybot not initialized in this repo

    const pythonCmd = await detectPythonCommand()
    if (!pythonCmd) return

    const now = Date.now()
    const { prompt, model } = await extractTurnContext(input.transcript_path)
    const turn: ClaudeTurn = {
        id: `claude_${input.session_id}_${now}`,
        sessionId: input.session_id,
        source: "claude-code",
        // Claude Code's transcript only has the bare model id (e.g.
        // "claude-sonnet-5"), not an "anthropic/..." formatted string the
        // way OpenCode's SDK provides — Claude Code is Anthropic-only, so
        // prefixing here keeps model_provider/model_id splitting the same
        // way on the Research Mode side regardless of which agent produced a
        // given Tasklet.
        model: model ? `anthropic/${model}` : undefined,
        prompt,
        response: input.last_assistant_message ?? "",
        promptCreatedAt: now, // transcript doesn't reliably expose the original prompt timestamp — best available approximation
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
        // Hooks must never break the user's Claude Code session — swallow
        // and exit cleanly. There's no client to log through here (unlike
        // OpenCode's plugin, which has L.error via the SDK client), so a
        // failure here is silent by design rather than noisy in a way that
        // could look like a Claude Code problem.
    }
}

await main()
