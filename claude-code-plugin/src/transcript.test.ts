import { test, expect, afterEach } from "bun:test"
import { extractTurnContext } from "./transcript"
import path from "path"
import os from "os"

const tmpFiles: string[] = []

afterEach(async () => {
    for (const f of tmpFiles.splice(0)) {
        await Bun.file(f).delete().catch(() => { })
    }
})

async function writeTranscript(lines: unknown[]): Promise<string> {
    const p = path.join(os.tmpdir(), `transcript-test-${Date.now()}-${Math.random()}.jsonl`)
    await Bun.write(p, lines.map(l => JSON.stringify(l)).join("\n"))
    tmpFiles.push(p)
    return p
}

test("extracts a plain string content user message", async () => {
    const p = await writeTranscript([
        { type: "user", message: { role: "user", content: "reverse this string" } },
        { type: "assistant", message: { role: "assistant", model: "claude-sonnet-5", content: "done" } },
    ])
    const ctx = await extractTurnContext(p)
    expect(ctx.prompt).toBe("reverse this string")
    expect(ctx.model).toBe("claude-sonnet-5")
})

test("extracts text from content-block-array shaped assistant messages", async () => {
    const p = await writeTranscript([
        { type: "user", message: { role: "user", content: "add a function" } },
        { type: "assistant", message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "done" }] } },
    ])
    expect((await extractTurnContext(p)).prompt).toBe("add a function")
})

test("picks the LAST user message and LAST assistant model, not the first", async () => {
    const p = await writeTranscript([
        { type: "user", message: { role: "user", content: "first prompt" } },
        { type: "assistant", message: { role: "assistant", model: "claude-haiku-4-5" } },
        { type: "user", message: { role: "user", content: "second prompt" } },
        { type: "assistant", message: { role: "assistant", model: "claude-sonnet-5" } },
    ])
    const ctx = await extractTurnContext(p)
    expect(ctx.prompt).toBe("second prompt")
    expect(ctx.model).toBe("claude-sonnet-5")
})

test("returns empty fields for a missing file rather than throwing", async () => {
    const ctx = await extractTurnContext("/nonexistent/path.jsonl")
    expect(ctx.prompt).toBe("")
    expect(ctx.model).toBe("")
})

test("skips malformed lines instead of throwing", async () => {
    const p = path.join(os.tmpdir(), `transcript-test-malformed-${Date.now()}.jsonl`)
    await Bun.write(p, "not json\n" + JSON.stringify({ type: "user", message: { role: "user", content: "ok prompt" } }))
    tmpFiles.push(p)
    expect((await extractTurnContext(p)).prompt).toBe("ok prompt")
})

test("ignores non-text content blocks (e.g. thinking) when extracting a user prompt", async () => {
    const p = await writeTranscript([
        { type: "user", message: { role: "user", content: [{ type: "thinking", thinking: "internal" }, { type: "text", text: "visible prompt" }] } },
    ])
    expect((await extractTurnContext(p)).prompt).toBe("visible prompt")
})
