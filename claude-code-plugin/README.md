# Tracybot — Claude Code Plugin

Records Tasklet snapshots for [Tracybot](../README.md) when using Claude Code, the same way `opencode-plugin` does for OpenCode CLI.

## How it differs from `opencode-plugin`

Claude Code doesn't have OpenCode's Plan/Build mode distinction, so this doesn't produce the same `Tasklet` shape — each recorded unit is one `ClaudeTurn` (one `UserPromptSubmit` → `Stop` cycle that changed the repo via `Edit`/`Write`/`MultiEdit` or a `Bash` command), tagged `"source": "claude-code"` so `buildHistory.ts` can tell the two shapes apart and parse each one correctly.

Prompt text is read from the turn's `transcript_path` rather than passed directly by a hook, and the response text comes from the `Stop` event's `last_assistant_message`.

## Install

```bash
bun install
bun run deploy
```

This builds the plugin and adds `PostToolUse` (matcher: `Edit|Write|MultiEdit|Bash`), `PreToolUse` (matcher: `Bash`) and `Stop` hooks to `~/.claude/settings.json`, without touching any hooks you already have configured there. If the hooks are already installed with an older matcher, the matcher is updated, and a missing `PreToolUse` hook is added.

### Bash-only turns

A shell command can change files without naming them (`sed -i`), so a turn that only used Bash is recorded when the working tree actually changed during it. `PreToolUse` takes a baseline of the tree just before the turn's first Bash command; at `Stop` the turn is recorded only if the tree differs from that baseline. Without this, `tracy.py` (which only skips when nothing changed since the *last snapshot*) would credit any edit you made by hand between turns to a turn that merely ran `ls` or the tests. If the `PreToolUse` hook isn't installed yet, the plugin falls back to that older behavior.

A turn that also used the Edit/Write tools is unaffected, and so is the one remaining limitation: a snapshot always captures the whole working tree, so a turn that really does change something still bundles any hand-written edits made just before it.

## Requirements

- [Bun](https://bun.sh) — the built hook script uses Bun-specific APIs (`Bun.file`, `Bun.$`), so it's invoked via `bun`, not `node`
- The target repository must already be initialized with Tracybot (`python init.py .`)

## Development

```bash
bun test      # unit tests
bun run build # bundles src/index.ts -> dist/tracybot-cc-hook.js
```

`src/transcript.ts`'s parsing of `transcript_path` is modeled on Anthropic's Messages API content shape, since Claude Code's hooks reference doesn't document the transcript's own JSONL entry schema — verify this against a real transcript file if prompt extraction looks wrong in practice.
