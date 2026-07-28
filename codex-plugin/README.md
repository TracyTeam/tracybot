# Tracybot — Codex CLI Plugin

Records Tasklet snapshots for [Tracybot](../README.md) when using OpenAI's Codex CLI, the same role `opencode-plugin` and `claude-code-plugin` play for their respective agents.

## How it differs from the other plugins

Like Claude Code, Codex CLI has no Plan/Build mode split, so this records one flat `CodexTurn` per `PostToolUse` → `Stop` cycle that touched a file, tagged `"source": "codex"`.

Two things are more direct here than in `claude-code-plugin`:
- The `Stop` hook's input includes a `model` field directly — no need to parse the transcript to find it.
- `apply_patch` (Codex's file-edit tool) reports the change via `tool_input.command` (patch/command text), not a clean file path — so unlike Claude Code's plugin, this one doesn't track which file was edited, only *that* an edit happened this turn (which is all the gating logic needs).

⚠️ **`src/transcript.ts` is unverified.** Claude Code's transcript parser in the sibling package was checked against a real `transcript.jsonl`; this one is only modeled on Codex's hooks reference plus the assumption that it's shaped similarly, since Codex's transcript entry schema isn't documented. If prompt extraction comes back empty in practice, this is the first place to check — see the file's own comment for details.

## Install

```bash
bun install
bun run deploy
```

Builds the plugin and adds `PostToolUse` (matcher: `apply_patch|Edit|Write`) and `Stop` hooks to `~/.codex/hooks.json`, without touching any hooks already configured there.

## Requirements

- [Bun](https://bun.sh) — the built hook script uses Bun-specific APIs (`Bun.file`, `Bun.$`), so it's invoked via `bun`, not `node`
- The target repository must already be initialized with Tracybot (`python init.py .`)

## Development

```bash
bun test      # unit tests
bun run build # bundles src/index.ts -> dist/tracybot-codex-hook.js
```
