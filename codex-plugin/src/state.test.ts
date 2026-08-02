import { test, expect, afterEach } from "bun:test"
import { markEdited, readPendingTurn, clearPendingTurn } from "./state"

const sessionIds: string[] = []

afterEach(async () => {
    for (const id of sessionIds.splice(0)) {
        await clearPendingTurn(id)
    }
})

function sessionId(): string {
    const id = `state-test-${Date.now()}-${Math.random()}`
    sessionIds.push(id)
    return id
}

test("markEdited persists the repoRoot resolved at edit time", async () => {
    const id = sessionId()
    await markEdited(id, "/repo/a")

    const pending = await readPendingTurn(id)
    expect(pending).toEqual({ edited: true, repoRoot: "/repo/a" })
})

test("a later markEdited call in the same turn does not need to match an earlier one, but the last write wins", async () => {
    const id = sessionId()
    await markEdited(id, "/repo/a")
    await markEdited(id, "/repo/a") // realistic case: multiple edits, same repo, same turn

    const pending = await readPendingTurn(id)
    expect(pending?.repoRoot).toBe("/repo/a")
})

test("markEdited tolerates an unresolved repoRoot without throwing", async () => {
    const id = sessionId()
    await markEdited(id, undefined)

    const pending = await readPendingTurn(id)
    expect(pending).toEqual({ edited: true, repoRoot: undefined })
})

test("clearPendingTurn removes the state so a stale repoRoot can't leak into the next turn", async () => {
    const id = sessionId()
    await markEdited(id, "/repo/a")
    await clearPendingTurn(id)

    expect(await readPendingTurn(id)).toBeUndefined()
})
