import path from "path"
import os from "os"
import type { PendingTurnState } from "./types"

// Hooks are separate process invocations with no shared memory, unlike
// OpenCode's plugin (one long-lived process with closures) — a turn's
// "did an edit happen" flag has to survive from the first PostToolUse call
// through however many more happen, until Stop reads and clears it. A tmp
// file keyed by session_id is the simplest thing that works across processes.
function statePath(sessionId: string): string {
    return path.join(os.tmpdir(), `tracybot-cc-turn-${sessionId}.json`)
}

export async function markFileEdited(sessionId: string, filePath: string): Promise<void> {
    const state = (await readPendingTurn(sessionId)) ?? { editedFiles: [] }
    if (!state.editedFiles.includes(filePath)) {
        state.editedFiles.push(filePath)
    }
    await Bun.write(statePath(sessionId), JSON.stringify(state))
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
