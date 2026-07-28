import { test, expect, afterEach } from "bun:test"
import { extractLastUserPrompt } from "./transcript"
import path from "path"
import os from "os"

// Fixtures match a real Codex rollout transcript's shape (verified against
// an actual session) — payload.role/content, not entry.type like Claude
// Code, and "input_text"/"output_text" content-block types, not "text".

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

function responseItem(payload: unknown) {
    return { timestamp: "2026-07-28T00:00:00.000Z", type: "response_item", payload }
}

test("extracts a user message, ignoring developer instruction messages", async () => {
    const p = await writeTranscript([
        responseItem({ type: "message", role: "developer", content: [{ type: "input_text", text: "<system instructions>" }] }),
        responseItem({ type: "message", role: "user", content: [{ type: "input_text", text: "add a prime checker" }] }),
        responseItem({ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }),
    ])
    expect(await extractLastUserPrompt(p)).toBe("add a prime checker")
})

test("picks the LAST user message, not the first", async () => {
    const p = await writeTranscript([
        responseItem({ type: "message", role: "user", content: [{ type: "input_text", text: "first prompt" }] }),
        responseItem({ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }),
        responseItem({ type: "message", role: "user", content: [{ type: "input_text", text: "second prompt" }] }),
    ])
    expect(await extractLastUserPrompt(p)).toBe("second prompt")
})

test("ignores non-message response_item entries (reasoning, custom_tool_call)", async () => {
    const p = await writeTranscript([
        responseItem({ type: "message", role: "user", content: [{ type: "input_text", text: "the real prompt" }] }),
        { timestamp: "t", type: "response_item", payload: { type: "reasoning", id: "rs_1", summary: [] } },
        { timestamp: "t", type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "ls" } },
    ])
    expect(await extractLastUserPrompt(p)).toBe("the real prompt")
})

test("returns empty string for a missing file rather than throwing", async () => {
    expect(await extractLastUserPrompt("/nonexistent/path.jsonl")).toBe("")
})

test("skips malformed lines instead of throwing", async () => {
    const p = path.join(os.tmpdir(), `codex-transcript-test-malformed-${Date.now()}.jsonl`)
    await Bun.write(p, "not json\n" + JSON.stringify(responseItem({ type: "message", role: "user", content: [{ type: "input_text", text: "ok prompt" }] })))
    tmpFiles.push(p)
    expect(await extractLastUserPrompt(p)).toBe("ok prompt")
})
