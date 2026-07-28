// Verified against a real transcript.jsonl (not just inferred from the
// Anthropic Messages API shape): each line has a top-level `type` of "user"
// or "assistant", and `message.content` is either a plain string (user) or
// a content-block array (assistant, e.g. [{type: "thinking", ...}]).
// Assistant entries also carry `message.model` — Claude Code's own
// "anthropic/claude-sonnet-4-6"-style formatted string isn't available here,
// just the bare model id (e.g. "claude-sonnet-5"); there's no providerID
// separate from OpenCode's SDK-provided one, so it's returned unprefixed.
export interface TurnContext {
    prompt: string
    model: string
}

// Never throws: worst case, some/all fields come back empty and the
// Tasklet-equivalent just has less detail, rather than failing entirely.
export async function extractTurnContext(transcriptPath: string): Promise<TurnContext> {
    const result: TurnContext = { prompt: "", model: "" }

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

            const type = (entry as { type?: string })?.type
            const message = (entry as { message?: { content?: unknown; model?: string } })?.message

            if (!result.model && type === "assistant" && message?.model) {
                result.model = message.model
            }

            if (!result.prompt && type === "user") {
                const asText = contentToText(message?.content)
                if (asText) result.prompt = asText
            }

            if (result.prompt && result.model) break
        }
    } catch {
        // transcript unreadable/missing — return whatever was found before the failure
    }

    return result
}

function contentToText(content: unknown): string {
    if (typeof content === "string") return content

    if (Array.isArray(content)) {
        return content
            .filter((block): block is { type: string; text: string } =>
                typeof block === "object" && block !== null && (block as { type?: string }).type === "text")
            .map(block => block.text)
            .join("\n")
    }

    return ""
}
