# Research Mode

Research Mode is an opt-in feature that lets a Tracybot user share their Tasklet history for a research study on AI-assisted coding behavior. It is off by default and can be disabled at any time. Works with all three supported agents ([opencode-plugin](../opencode-plugin/README.md), [claude-code-plugin](../claude-code-plugin/README.md), [codex-plugin](../codex-plugin/README.md)) — each payload records which one produced it via `agent_source`.

## Consent

Consent is **per repository**, not machine-wide — agreeing to share one project's Tasklet history doesn't enroll every other repo opened afterward. The first time a repo is opened (and once per repo thereafter, until a decision is made), the VS Code extension shows a prompt:

> Help improve Tracybot: share this repository's Tasklet history for a study on AI-assisted coding behavior?

Agreeing shows a Tier picker (Tier 1, the most conservative, is the default if dismissed) and generates a random, per-machine `participant_id` that is never derived from git identity (`user.name`/`user.email`) — the participant identity is shared across repos even though the enable/tier decision isn't. The decision (`enabled` + tier, or `declined`) is stored in that repo's `.git/tracybot/research-consent.json` — inside `.git` so it's never itself tracked or pushed by that repo's own history — and can be changed anytime from the Research Mode status bar item ("Disable for This Repo").

### Consent tiers

Tiers are additive — each includes everything in the tier below it.

| Tier | Adds |
|---|---|
| **1** (default) | Model, timestamps, file extensions touched, line-change counts, ownership-flip/BLEU stats. No prompt text, no code. |
| **2** | Plan/build prompt and response text (fenced code blocks in responses are redacted before leaving the machine). |
| **3** | The diff hunks touched by each Tasklet (`added_lines`/`removed_lines`), plus the BLEU-significance result per hunk. Never a full file or repo snapshot. |

The developer's own (non-AI) code is never collected, regardless of tier.

## What gets collected

One payload per Tasklet, built by `vscode-extension/src/research/buildResearchPayloads.ts` from `buildHistory()`'s output. See `vscode-extension/src/research/types.ts` for the exact field list per tier.

## Architecture

```
VS Code extension (research/)
  → queue.ts            locally queues built payloads + tracks a daily digest count
  → collectorRepo.ts     POSTs queued payloads to the research collector relay
       ↓ HTTPS
research-collector-worker/  (Cloudflare Worker)
  → validates the request against a public submit key, rate-limits per participant,
    validates payload shape (zod), then writes one file per submission via
    GitHub's Contents API
       ↓
private collector GitHub repo
  → <participant_id>/<timestamp>_<tasklet_id>.json
```

### Why a relay instead of the extension pushing directly

Tracybot is published on the VS Code Marketplace for anyone to install, so there's no per-participant enrollment step to hand out individual credentials. The extension instead embeds a **public** submit key — public because the extension's source is itself public, so a key baked into it must be treated as public knowledge regardless of intent. Security comes from the relay's posture, not from the key being secret:

- the key can only submit new data (never read, modify, or delete)
- per-participant daily rate limiting (`research-collector-worker/src/rateLimit.ts`)
- strict schema validation before anything is written (`research-collector-worker/src/schema.ts`)
- the real GitHub write credential lives only in the Worker's secrets, never in any client

### Triggers

A rebuild-and-submit attempt happens on extension activation, on opening a repository, on any git state change (including a commit), and when the user explicitly runs "AI Blame". There is no polling — if none of those happen, a queued Tasklet stays queued until one does.

## Configuration reference

Stored per-repo in `.git/tracybot/research-consent.json` (see `vscode-extension/src/research/repoConsent.ts`), not as VS Code Settings:

| Field | Purpose |
|---|---|
| `decision` | `"enabled"` or `"declined"` — absent entirely means undecided (prompt shows next time the repo is opened) |
| `consentTier` | `1`, `2`, or `3` — see tiers above; only present when `decision` is `"enabled"` |
| `repoUrl` | Optional, not currently set through any UI — lets researchers later check if a repo is open source, if manually added to the file |

## Local development

- `test/generate-research-mode-mock.sh` creates a throwaway repo with one OpenCode-shaped Tasklet (with `id`/`sessionId`/timestamps) that `buildResearchPayloads` can key on — unlike `test/generate-mock-repository.py`, which predates Research Mode and produces plain-string Tasklet descriptions with no `taskletId`.
- `test/generate-claude-code-mock.sh` / `test/generate-codex-mock.sh` do the same for a Claude Code- or Codex-shaped Tasklet (`source: "claude-code"` / `"codex"`), without needing real hooks configured for either.
- `research-collector-worker/` is deployed independently via `wrangler deploy`; see its `wrangler.jsonc` and `src/secrets.d.ts` for the two required secrets (`SUBMIT_KEY`, `GITHUB_TOKEN`).

## A note on unverified transcript parsing

Both `claude-code-plugin` and `codex-plugin` extract prompt text by parsing each agent's `transcript_path` JSONL file. `claude-code-plugin`'s parser has been checked against a real transcript; `codex-plugin`'s has not (see its own README) — if Codex-sourced Tasklets show up with an empty `build_prompt`, start there.
