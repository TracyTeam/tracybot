import { test, expect, afterEach } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs"
import { appendContextTurn, readContextTurns, clearContextTurns, MAX_CONTEXT_TURNS, markFileEdited, markBashRan, readPendingTurn, clearPendingTurn } from "./state"

const sessionIds: string[] = []

afterEach(async () => {
    for (const id of sessionIds.splice(0)) {
        await clearContextTurns(id)
        await clearPendingTurn(id)
    }
})

function sessionId(): string {
    const id = `state-test-${Date.now()}-${Math.random()}`
    sessionIds.push(id)
    return id
}

test("readContextTurns returns an empty list when nothing was recorded", async () => {
    expect(await readContextTurns(sessionId(), "/repo/a")).toEqual([])
})

test("appendContextTurn keeps turns oldest first", async () => {
    const id = sessionId()
    await appendContextTurn(id, "/repo/a", { prompt: "what could we add?", response: "1. Request IDs" })
    await appendContextTurn(id, "/repo/a", { prompt: "tell me more about 1", response: "It would..." })

    expect((await readContextTurns(id, "/repo/a")).map(t => t.prompt)).toEqual(["what could we add?", "tell me more about 1"])
})

test("appendContextTurn drops the oldest turns beyond MAX_CONTEXT_TURNS", async () => {
    const id = sessionId()
    for (let i = 0; i < MAX_CONTEXT_TURNS + 2; i++) {
        await appendContextTurn(id, "/repo/a", { prompt: `p${i}`, response: "" })
    }

    const turns = await readContextTurns(id, "/repo/a")
    expect(turns).toHaveLength(MAX_CONTEXT_TURNS)
    expect(turns[0]?.prompt).toBe("p2")
})

test("context is kept per session", async () => {
    const a = sessionId()
    const b = sessionId()
    await appendContextTurn(a, "/repo/a", { prompt: "only in a", response: "" })

    expect(await readContextTurns(b, "/repo/a")).toEqual([])
})

test("readContextTurns only returns turns from the given repo, without the repo path", async () => {
    const id = sessionId()
    await appendContextTurn(id, "/repo/private", { prompt: "about the private repo", response: "" })
    await appendContextTurn(id, "/repo/a", { prompt: "about a", response: "ok" })

    expect(await readContextTurns(id, "/repo/a")).toEqual([{ prompt: "about a", response: "ok" }])
})

test("clearContextTurns removes the context so it isn't attached to a later edit", async () => {
    const id = sessionId()
    await appendContextTurn(id, "/repo/a", { prompt: "p", response: "r" })
    await clearContextTurns(id)

    expect(await readContextTurns(id, "/repo/a")).toEqual([])
})

test("markBashRan records each working directory once, alongside edited files", async () => {
    const id = sessionId()
    await markFileEdited(id, "/repo/a/file.ts")
    await markBashRan(id, "/repo/a")
    await markBashRan(id, "/repo/a")

    expect(await readPendingTurn(id)).toEqual({ editedFiles: ["/repo/a/file.ts"], bashCwds: ["/repo/a"] })
})

test.skipIf(process.platform === "win32")("state files are readable only by their owner", async () => {
    const id = sessionId()
    await markFileEdited(id, "/repo/a/file.ts")
    await appendContextTurn(id, "/repo/a", { prompt: "p", response: "r" })

    for (const name of [`tracybot-cc-turn-${id}.json`, `tracybot-cc-context-${id}.json`]) {
        expect(fs.statSync(path.join(os.tmpdir(), name)).mode & 0o777).toBe(0o600)
    }
})
