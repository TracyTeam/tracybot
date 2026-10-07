import path from "path"
import os from "os"
import fs from "fs"
import type { ContextTurn, PendingTurnState } from "./types"

// Hooks are separate process invocations with no shared memory, unlike
// OpenCode's plugin (one long-lived process with closures) — a turn's
// "did an edit happen" flag has to survive from the first PostToolUse call
// through however many more happen, until Stop reads and clears it. A tmp
// file keyed by session_id is the simplest thing that works across processes.
function statePath(sessionId: string): string {
    return path.join(os.tmpdir(), `tracybot-cc-turn-${sessionId}.json`)
}

function contextPath(sessionId: string): string {
    return path.join(os.tmpdir(), `tracybot-cc-context-${sessionId}.json`)
}

// Keeps only the most recent non-editing turns, so a long discussion
// doesn't bury the turn that actually made the change.
export const MAX_CONTEXT_TURNS = 5

// Saved turns are tagged with the repo they happened in, so a discussion
// about one repo is never attached to (and pushed with) another repo's edit.
interface SavedContextTurn extends ContextTurn {
    repoRoot: string
}

// Owner-only: these files hold prompt text, and os.tmpdir() is the shared
// /tmp on Linux.
async function writePrivate(filePath: string, data: string): Promise<void> {
    await fs.promises.writeFile(filePath, data, { mode: 0o600 })
}

export async function markFileEdited(sessionId: string, filePath: string): Promise<void> {
    const state = (await readPendingTurn(sessionId)) ?? { editedFiles: [] }
    if (!state.editedFiles.includes(filePath)) {
        state.editedFiles.push(filePath)
    }
    await writePrivate(statePath(sessionId), JSON.stringify(state))
}

export async function markBashRan(sessionId: string, cwd: string): Promise<void> {
    const state = (await readPendingTurn(sessionId)) ?? { editedFiles: [] }
    state.bashCwds ??= []
    if (!state.bashCwds.includes(cwd)) {
        state.bashCwds.push(cwd)
    }
    await writePrivate(statePath(sessionId), JSON.stringify(state))
}

export async function readPendingTurn(sessionId: string): Promise<PendingTurnState | undefined> {
    const file = Bun.file(statePath(sessionId))
    if (!(await file.exists())) return undefined
    return file.json() as Promise<PendingTurnState>
}

export async function clearPendingTurn(sessionId: string): Promise<void> {
    const file = Bun.file(statePath(sessionId))
    if (await file.exists()) {
        await file.delete()
    }
}

export async function appendContextTurn(sessionId: string, repoRoot: string, turn: ContextTurn): Promise<void> {
    const turns = [...(await readSavedContextTurns(sessionId)), { repoRoot, ...turn }].slice(-MAX_CONTEXT_TURNS)
    await writePrivate(contextPath(sessionId), JSON.stringify(turns))
}

export async function readContextTurns(sessionId: string, repoRoot: string): Promise<ContextTurn[]> {
    return (await readSavedContextTurns(sessionId))
        .filter(turn => turn.repoRoot === repoRoot)
        .map(({ prompt, response }) => ({ prompt, response }))
}

async function readSavedContextTurns(sessionId: string): Promise<SavedContextTurn[]> {
    const file = Bun.file(contextPath(sessionId))
    if (!(await file.exists())) return []
    return file.json() as Promise<SavedContextTurn[]>
}

export async function clearContextTurns(sessionId: string): Promise<void> {
    const file = Bun.file(contextPath(sessionId))
    if (await file.exists()) {
        await file.delete()
    }
}
