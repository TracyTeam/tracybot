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

// What Claude Code does around a Bash tool call: PreToolUse fires before the
// command runs (so the tree at that moment is the turn's baseline), PostToolUse
// after it. `change` stands in for whatever the command itself does to files.
async function bashTurn(opts: { id: string, repo: string, transcriptDir: string, prompt: string, response: string, change?: () => void }): Promise<void> {
    const { id, repo, transcriptDir, prompt, response, change } = opts
    await runHook("pre-tool-use", { session_id: id, cwd: repo, tool_name: "Bash", tool_input: { command: "..." } })
    change?.()
    await runHook("post-tool-use", { session_id: id, cwd: repo, tool_name: "Bash", tool_input: { command: "..." } })
    await runHook("stop", { session_id: id, cwd: repo, transcript_path: writeTranscript(transcriptDir, prompt), last_assistant_message: response })
}

test("a Bash-only turn that changes nothing does not claim the user's own hand-written edits", async () => {
    const repo = await makeRepo()
    const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracy-transcript-test-"))
    tmpDirs.push(transcriptDir)
    const id = sessionId()

    // Turn 1: Claude really changes app.js through Bash.
    await bashTurn({ id, repo, transcriptDir, prompt: "rename the variable", response: "Renamed.",
        change: () => fs.writeFileSync(path.join(repo, "app.js"), "var SERVER_TIMING_NAME_REGEXP = /x/;\n") })
    expect((await latestSnapshotTurn(repo))?.prompt).toBe("rename the variable")

    // The user then writes a whole new file by hand, no AI involved.
    fs.writeFileSync(path.join(repo, "mine.js"), "function mine() {\n  const a = 1\n  const b = 2\n  return a + b\n}\n")

    // Turn 2: Claude only runs the tests. Nothing in the repo changes during the turn.
    await bashTurn({ id, repo, transcriptDir, prompt: "run the tests", response: "All green." })

    // No snapshot is recorded for it, so mine.js isn't credited to "run the tests".
    expect((await latestSnapshotTurn(repo))?.prompt).toBe("rename the variable")
    // And, like any turn that changed nothing, it is kept as context for the next change.
    expect(await readContextTurns(id, repo)).toEqual([{ prompt: "run the tests", response: "All green." }])
})

test("a Bash turn that really changes a file is still recorded when a baseline exists", async () => {
    const repo = await makeRepo()
    const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracy-transcript-test-"))
    tmpDirs.push(transcriptDir)
    const id = sessionId()

    await bashTurn({ id, repo, transcriptDir, prompt: "rename the variable", response: "Renamed.",
        change: () => fs.writeFileSync(path.join(repo, "app.js"), "var SERVER_TIMING_NAME_REGEXP = /x/;\n") })

    expect((await latestSnapshotTurn(repo))?.prompt).toBe("rename the variable")
    expect(await readContextTurns(id, repo)).toEqual([])
})

test("a later Bash call in the same turn does not move the baseline past an earlier call's change", async () => {
    const repo = await makeRepo()
    const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracy-transcript-test-"))
    tmpDirs.push(transcriptDir)
    const id = sessionId()
    const bash = { session_id: id, cwd: repo, tool_name: "Bash", tool_input: { command: "..." } }

    // 1st call edits the file, 2nd call (e.g. running the tests) changes nothing.
    await runHook("pre-tool-use", bash)
    fs.writeFileSync(path.join(repo, "app.js"), "var SERVER_TIMING_NAME_REGEXP = /x/;\n")
    await runHook("post-tool-use", bash)
    await runHook("pre-tool-use", bash)
    await runHook("post-tool-use", bash)
    await runHook("stop", { session_id: id, cwd: repo, transcript_path: writeTranscript(transcriptDir, "rename and run the tests"), last_assistant_message: "Done." })

    expect((await latestSnapshotTurn(repo))?.prompt).toBe("rename and run the tests")
})

test("a turn that edited files with the Edit tool is unaffected by a Bash baseline", async () => {
    const repo = await makeRepo()
    const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracy-transcript-test-"))
    tmpDirs.push(transcriptDir)
    const id = sessionId()

    await runHook("pre-tool-use", { session_id: id, cwd: repo, tool_name: "Bash", tool_input: { command: "ls" } })
    await runHook("post-tool-use", { session_id: id, cwd: repo, tool_name: "Bash", tool_input: { command: "ls" } })
    fs.writeFileSync(path.join(repo, "app.js"), "var SERVER_TIMING_NAME_REGEXP = /x/;\n")
    await runHook("post-tool-use", { session_id: id, cwd: repo, tool_name: "Edit", tool_input: { file_path: path.join(repo, "app.js") } })
    await runHook("stop", { session_id: id, cwd: repo, transcript_path: writeTranscript(transcriptDir, "edit it"), last_assistant_message: "Edited." })

    expect((await latestSnapshotTurn(repo))?.prompt).toBe("edit it")
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

test("a change in one repo keeps another repo's discussion for that repo's next change", async () => {
    const repoA = await makeRepo()
    const repoB = await makeRepo()
    const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracy-transcript-test-"))
    tmpDirs.push(transcriptDir)
    const id = sessionId()

    await runHook("stop", { session_id: id, cwd: repoA, transcript_path: writeTranscript(transcriptDir, "what should we rename in A?"), last_assistant_message: "TOKEN_REGEXP." })

    fs.writeFileSync(path.join(repoB, "app.js"), "var B_REGEXP = /x/;\n")
    await runHook("post-tool-use", { session_id: id, cwd: repoB, tool_name: "Bash", tool_input: { command: "sed -i '' ... app.js" } })
    await runHook("stop", { session_id: id, cwd: repoB, transcript_path: writeTranscript(transcriptDir, "fix B first"), last_assistant_message: "Fixed." })

    fs.writeFileSync(path.join(repoA, "app.js"), "var SERVER_TIMING_NAME_REGEXP = /x/;\n")
    await runHook("post-tool-use", { session_id: id, cwd: repoA, tool_name: "Bash", tool_input: { command: "sed -i '' ... app.js" } })
    await runHook("stop", { session_id: id, cwd: repoA, transcript_path: writeTranscript(transcriptDir, "now do A"), last_assistant_message: "Renamed." })

    expect((await latestSnapshotTurn(repoB))?.context).toEqual([])
    const turnA = await latestSnapshotTurn(repoA)
    expect(turnA?.prompt).toBe("now do A")
    expect(turnA?.context).toEqual([{ prompt: "what should we rename in A?", response: "TOKEN_REGEXP." }])
})
