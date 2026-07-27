# Research Mode

Research Mode is an opt-in feature that lets a Tracybot user share their Tasklet history for a research study on AI-assisted coding behavior. It is off by default and can be disabled at any time.

## Consent

On first activation, the VS Code extension shows a one-time prompt:

> Help improve Tracybot: share your Tasklet history for a study on AI-assisted coding behavior?

Agreeing enables Research Mode at **Tier 1** (the most conservative tier) and generates a random, per-machine `participant_id` that is never derived from git identity (`user.name`/`user.email`). The tier can be raised at any time via `tracybot.researchMode.consentTier` in Settings, and Research Mode can be disabled at any time (status bar → "Disable Research Mode", or the setting directly).

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

| Setting | Default | Purpose |
|---|---|---|
| `tracybot.researchMode.enabled` | `false` | Master opt-in switch |
| `tracybot.researchMode.consentTier` | `1` | `1`, `2`, or `3` — see tiers above |
| `tracybot.researchMode.projectTag` | `""` | Participant-chosen alias for the project, never the real repo name |
| `tracybot.researchMode.repoUrl` | `""` | Optional — shared only if the participant fills this in, lets researchers later check if a repo is open source |

## Local development

- `test/generate-research-mode-mock.sh` creates a throwaway repo with one Tasklet in the modern JSON format (with `id`/`sessionId`/timestamps) that `buildResearchPayloads` can key on — unlike `test/generate-mock-repository.py`, which predates Research Mode and produces plain-string Tasklet descriptions with no `taskletId`.
- `research-collector-worker/` is deployed independently via `wrangler deploy`; see its `wrangler.jsonc` and `src/secrets.d.ts` for the two required secrets (`SUBMIT_KEY`, `GITHUB_TOKEN`).
