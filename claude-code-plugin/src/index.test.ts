import { test, expect, afterEach } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs"
import { readContextTurns, clearContextTurns } from "./state"

// Runs the real hook entry point against a temporary repo and the real
// tracking/tracy.py, the same way Claude Code invokes it.
const $ = Bun.$
const HOOK = path.join(import.meta.dir, "index.ts")
const TRACY_PY = path.resolve(import.meta.dir, "..", "..", "tracking", "tracy.py")

const tmpDirs: string[] = []
const sessionIds: string[] = []

afterEach(async () => {
    for (const dir of tmpDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true })
    }
    for (const id of sessionIds.splice(0)) {
        await clearContextTurns(id)
    }
})

function sessionId(): string {
    const id = `index-test-${Date.now()}-${Math.random()}`
    sessionIds.push(id)
    return id
}

async function makeRepo(): Promise<string> {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tracy-hook-test-")))
    tmpDirs.push(dir)
    await $`git init -q && git config user.email test@example.com && git config user.name Test`.cwd(dir).quiet()
    fs.writeFileSync(path.join(dir, "app.js"), "var TOKEN_REGEXP = /x/;\n")
    await $`git add app.js && git commit -q -m init`.cwd(dir).quiet()
    return dir
}

function writeTranscript(dir: string, prompt: string): string {
    const transcriptPath = path.join(dir, "transcript.jsonl")
    fs.writeFileSync(transcriptPath, [
        { type: "user", message: { role: "user", content: prompt } },
        { type: "assistant", message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "done" }] } },
    ].map(l => JSON.stringify(l)).join("\n"))
    return transcriptPath
}

async function runHook(event: string, input: object): Promise<void> {
    const proc = Bun.spawn([process.execPath, HOOK, event], {
        stdin: new Blob([JSON.stringify(input)]),
        env: { ...process.env, TRACY_SNAPSHOT_SCRIPT: TRACY_PY },
        stdout: "ignore",
        stderr: "ignore",
    })
    await proc.exited
}

async function latestSnapshotTurn(repo: string): Promise<any> {
    const tracyId = (await $`git config --get tracy.current-id`.cwd(repo).quiet().nothrow()).stdout.toString().trim()
    if (!tracyId) return undefined
    return JSON.parse(await $`git log -1 --format=%b refs/tracy-local/${tracyId}`.cwd(repo).text())
}

test("a turn that changes files only through Bash is recorded with its own prompt", async () => {
    const repo = await makeRepo()
    const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracy-transcript-test-"))
    tmpDirs.push(transcriptDir)
    const id = sessionId()

    // What `sed -i` run by Claude through the Bash tool does.
    fs.writeFileSync(path.join(repo, "app.js"), "var SERVER_TIMING_NAME_REGEXP = /x/;\n")
    await runHook("post-tool-use", { session_id: id, cwd: repo, tool_name: "Bash", tool_input: { command: "sed -i '' ... app.js" } })
    await runHook("stop", { session_id: id, cwd: repo, transcript_path: writeTranscript(transcriptDir, "change the names of the variables"), last_assistant_message: "Renamed." })

    const turn = await latestSnapshotTurn(repo)
    expect(turn?.prompt).toBe("change the names of the variables")
    expect(await readContextTurns(id, repo)).toEqual([])
})

test("a Bash-only turn that changes nothing is kept as context, not recorded", async () => {
    const repo = await makeRepo()
    const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracy-transcript-test-"))
    tmpDirs.push(transcriptDir)
    const id = sessionId()

    await runHook("post-tool-use", { session_id: id, cwd: repo, tool_name: "Bash", tool_input: { command: "grep -n TOKEN app.js" } })
    await runHook("stop", { session_id: id, cwd: repo, transcript_path: writeTranscript(transcriptDir, "what could we rename?"), last_assistant_message: "TOKEN_REGEXP is too generic." })

    expect(await latestSnapshotTurn(repo)).toBeUndefined()
    expect(await readContextTurns(id, repo)).toEqual([{ prompt: "what could we rename?", response: "TOKEN_REGEXP is too generic." }])
})

test("a discussion turn is attached to the next change in the same repo", async () => {
    const repo = await makeRepo()
    const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracy-transcript-test-"))
    tmpDirs.push(transcriptDir)
    const id = sessionId()

    await runHook("stop", { session_id: id, cwd: repo, transcript_path: writeTranscript(transcriptDir, "what should we rename?"), last_assistant_message: "TOKEN_REGEXP." })

    fs.writeFileSync(path.join(repo, "app.js"), "var SERVER_TIMING_NAME_REGEXP = /x/;\n")
    await runHook("post-tool-use", { session_id: id, cwd: repo, tool_name: "Bash", tool_input: { command: "sed -i '' ... app.js" } })
    await runHook("stop", { session_id: id, cwd: repo, transcript_path: writeTranscript(transcriptDir, "yes"), last_assistant_message: "Renamed." })

    const turn = await latestSnapshotTurn(repo)
    expect(turn?.prompt).toBe("yes")
    expect(turn?.context).toEqual([{ prompt: "what should we rename?", response: "TOKEN_REGEXP." }])
})

test("a discussion turn in another repo is never attached to this repo's change", async () => {
    const repo = await makeRepo()
    const otherRepo = await makeRepo()
    const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracy-transcript-test-"))
    tmpDirs.push(transcriptDir)
    const id = sessionId()

    await runHook("stop", { session_id: id, cwd: otherRepo, transcript_path: writeTranscript(transcriptDir, "about the other project"), last_assistant_message: "Sure." })

    fs.writeFileSync(path.join(repo, "app.js"), "var SERVER_TIMING_NAME_REGEXP = /x/;\n")
    await runHook("post-tool-use", { session_id: id, cwd: repo, tool_name: "Bash", tool_input: { command: "sed -i '' ... app.js" } })
    await runHook("stop", { session_id: id, cwd: repo, transcript_path: writeTranscript(transcriptDir, "rename it"), last_assistant_message: "Renamed." })

    const turn = await latestSnapshotTurn(repo)
    expect(turn?.prompt).toBe("rename it")
    expect(turn?.context).toEqual([])
})
