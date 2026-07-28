import path from "path"
import os from "os"
import type { PendingTurnState } from "./types"

// Hooks are separate process invocations with no shared memory — an edit
// flag has to survive from PostToolUse through however many more of those
// fire, until Stop reads and clears it. A tmp file keyed by session_id is
// the simplest thing that works across processes.
function statePath(sessionId: string): string {
    return path.join(os.tmpdir(), `tracybot-codex-turn-${sessionId}.json`)
}

export async function markEdited(sessionId: string): Promise<void> {
    const state: PendingTurnState = { edited: true }
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
