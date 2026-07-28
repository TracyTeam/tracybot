// UNVERIFIED — unlike claude-code-plugin's transcript parser (checked
// against a real transcript.jsonl from an actual session), this one is only
// modeled on Codex's hooks reference description ("the session transcript
// file, if any") plus the reasonable assumption that it's shaped like Claude
// Code's (both are JSONL conversation logs, and Codex's hook event names/
// fields otherwise mirror Claude Code's closely). Model doesn't need to be
// extracted here — Codex's hook input includes a `model` field directly
// (unlike Claude Code), which index.ts reads straight from the hook payload.
// Verify this against a real transcript.jsonl before relying on it in
// production; never throws, so worst case the prompt just comes back empty.
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

            const role = (entry as { type?: string; message?: { role?: string } })?.type
                ?? (entry as { message?: { role?: string } })?.message?.role

            if (role !== "user") continue

            const content = (entry as { message?: { content?: unknown } })?.message?.content
            const asText = contentToText(content)
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
                typeof block === "object" && block !== null && (block as { type?: string }).type === "text")
            .map(block => block.text)
            .join("\n")
    }

    return ""
}
