// Verified against a real Codex CLI rollout transcript (not just inferred
// from the hooks reference). The actual shape is quite different from
// Claude Code's:
//   { "type": "response_item", "payload": { "type": "message", "role": "user" | "assistant" | "developer", "content": [{ "type": "input_text" | "output_text", "text": "..." }] } }
// The role/content live under `payload`, not at the entry's top level, and
// content-block types are "input_text"/"output_text" rather than "text".
// "developer" entries (system/instruction messages Codex injects) must be
// excluded — only "user" is the participant's actual prompt.
export async function extractLastUserPrompt(transcriptPath: string): Promise<string> {
    try {
        const text = await Bun.file(transcriptPath).text()
        const lines = text.split("\n").filter(l => l.trim().length > 0)

        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i]
            if (!line) continue

            let entry: unknown
            try {
                entry = JSON.parse(line)
            } catch {
                continue
            }

            const payload = (entry as { payload?: { type?: string; role?: string; content?: unknown } })?.payload
            if (!payload || payload.type !== "message" || payload.role !== "user") continue

            const asText = contentToText(payload.content)
            if (asText) return asText
        }
    } catch {
        // transcript unreadable/missing — fall through to empty prompt
    }

    return ""
}

function contentToText(content: unknown): string {
    if (typeof content === "string") return content

    if (Array.isArray(content)) {
        return content
            .filter((block): block is { type: string; text: string } =>
                typeof block === "object" && block !== null && (block as { type?: string }).type === "input_text")
            .map(block => block.text)
            .join("\n")
    }

    return ""
}
