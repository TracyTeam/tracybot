# Tracybot — Claude Code Plugin

Records Tasklet snapshots for [Tracybot](../README.md) when using Claude Code, the same way `opencode-plugin` does for OpenCode CLI.

## How it differs from `opencode-plugin`

Claude Code doesn't have OpenCode's Plan/Build mode distinction, so this doesn't produce the same `Tasklet` shape — each recorded unit is one `ClaudeTurn` (one `UserPromptSubmit` → `Stop` cycle that touched a file via `Edit`/`Write`/`MultiEdit`), tagged `"source": "claude-code"` so `buildHistory.ts` can tell the two shapes apart and parse each one correctly.

Prompt text is read from the turn's `transcript_path` rather than passed directly by a hook, and the response text comes from the `Stop` event's `last_assistant_message`.

## Install

```bash
bun install
bun run deploy
```

This builds the plugin and adds `PostToolUse` (matcher: `Edit|Write|MultiEdit`) and `Stop` hooks to `~/.claude/settings.json`, without touching any hooks you already have configured there.

## Requirements

- [Bun](https://bun.sh) — the built hook script uses Bun-specific APIs (`Bun.file`, `Bun.$`), so it's invoked via `bun`, not `node`
- The target repository must already be initialized with Tracybot (`python init.py .`)

## Development

```bash
bun test      # unit tests
bun run build # bundles src/index.ts -> dist/tracybot-cc-hook.js
```

`src/transcript.ts`'s parsing of `transcript_path` is modeled on Anthropic's Messages API content shape, since Claude Code's hooks reference doesn't document the transcript's own JSONL entry schema — verify this against a real transcript file if prompt extraction looks wrong in practice.
