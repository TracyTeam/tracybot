import { test, expect, afterEach } from "bun:test"
import { extractLastUserPrompt } from "./transcript"
import path from "path"
import os from "os"

// These test the parser's assumed schema, not a real Codex transcript — see
// the "UNVERIFIED" comment in transcript.ts. If real Codex data turns out to
// be shaped differently, these tests (and the parser) need updating together.

const tmpFiles: string[] = []

afterEach(async () => {
    for (const f of tmpFiles.splice(0)) {
        await Bun.file(f).delete().catch(() => { })
    }
})

async function writeTranscript(lines: unknown[]): Promise<string> {
    const p = path.join(os.tmpdir(), `codex-transcript-test-${Date.now()}-${Math.random()}.jsonl`)
    await Bun.write(p, lines.map(l => JSON.stringify(l)).join("\n"))
    tmpFiles.push(p)
    return p
}

test("extracts a plain string content user message", async () => {
    const p = await writeTranscript([
        { type: "user", message: { role: "user", content: "add a prime checker" } },
        { type: "assistant", message: { role: "assistant", content: "done" } },
    ])
    expect(await extractLastUserPrompt(p)).toBe("add a prime checker")
})

test("picks the LAST user message, not the first", async () => {
    const p = await writeTranscript([
        { type: "user", message: { role: "user", content: "first prompt" } },
        { type: "assistant", message: { role: "assistant", content: "ok" } },
        { type: "user", message: { role: "user", content: "second prompt" } },
    ])
    expect(await extractLastUserPrompt(p)).toBe("second prompt")
})

test("returns empty string for a missing file rather than throwing", async () => {
    expect(await extractLastUserPrompt("/nonexistent/path.jsonl")).toBe("")
})

test("skips malformed lines instead of throwing", async () => {
    const p = path.join(os.tmpdir(), `codex-transcript-test-malformed-${Date.now()}.jsonl`)
    await Bun.write(p, "not json\n" + JSON.stringify({ type: "user", message: { role: "user", content: "ok prompt" } }))
    tmpFiles.push(p)
    expect(await extractLastUserPrompt(p)).toBe("ok prompt")
})
