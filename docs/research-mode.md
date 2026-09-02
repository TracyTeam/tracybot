# Research Mode

Research Mode is an opt-in feature that lets a Tracybot user share their Tasklet history for a research study on AI-assisted coding behavior. It is off by default and can be disabled at any time. Works with all three supported agents ([opencode-plugin](../opencode-plugin/README.md), [claude-code-plugin](../claude-code-plugin/README.md), [codex-plugin](../codex-plugin/README.md)) — each payload records which one produced it via `agent_source`.

## Consent

Consent is **per repository**, not machine-wide — agreeing to share one project's Tasklet history doesn't enroll every other repo opened afterward. The first time a repo is opened (and once per repo thereafter, until a decision is made), the VS Code extension shows a prompt:

> Help improve Tracybot: share this repository's Tasklet history for a study on AI-assisted coding behavior?

Agreeing shows a Tier picker (Tier 1, the most conservative option, is the default if dismissed) and generates a random, per-machine `participant_id` that is never derived from git identity (`user.name`/`user.email`) — the participant identity is shared across repos even though the enable/tier decision isn't. The decision (`enabled` + tier, or `declined`) is stored in that repo's `.git/tracybot/research-consent.json` — inside `.git` so it's never itself tracked or pushed by that repo's own history — and can be changed anytime from the Research Mode status bar item ("Disable for This Repo").

### Consent tiers

Tiers are additive — each includes everything in the tier below it.

| Tier | Adds |
|---|---|
| **1** (default) | Model, timestamps, file extensions touched, line-change counts, ownership-flip/BLEU stats, the taskletIds of prior Tasklets that previously owned any line this one currently owns (`history_tasklet_ids`), plus plan/build prompt and response text (fenced code blocks in responses are redacted before leaving the machine). |
| **2** | The diff hunks touched by each Tasklet (`added_lines`/`removed_lines`), plus the BLEU-significance result per hunk. Never a full file or repo snapshot. |

The developer's own (non-AI) code is never collected, regardless of tier.

## Requesting or deleting your data

The Research Mode status bar item's menu has a "Request My Data" action (only shown once a repo has opted in — there's nothing to request otherwise). It copies your `participant_id` and shows it in a message; email that ID to lirongy@chalmers.se to request a copy or deletion of everything linked to it. There's no automated export/delete pipeline yet, so fulfillment is manual on our end. This is also how a participant in a supervised study (e.g. a classroom) can self-report their id to the researcher, since the tool itself never ties `participant_id` to a real identity.

## What gets collected

One payload per Tasklet, built by `vscode-extension/src/research/buildResearchPayloads.ts` from `buildHistory()`'s output. See `vscode-extension/src/research/types.ts` for the exact field list per tier.

`repo_url` is read live from the repo's `origin` remote (`vscode-extension/src/research/gitRemote.ts`) at submission time — it isn't something the participant sets, and isn't stored in the consent file. There's no separate consent gate for it: for an open-source repo the URL doesn't tell us anything not already public, and for a private one the URL alone doesn't grant access either way.

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
| `consentTier` | `1` or `2` — see tiers above; only present when `decision` is `"enabled"` |

## Local development

- `test/generate-research-mode-mock.sh` creates a throwaway repo with one OpenCode-shaped Tasklet (with `id`/`sessionId`/timestamps) that `buildResearchPayloads` can key on — unlike `test/generate-mock-repository.py`, which predates Research Mode and produces plain-string Tasklet descriptions with no `taskletId`.
- `test/generate-claude-code-mock.sh` / `test/generate-codex-mock.sh` do the same for a Claude Code- or Codex-shaped Tasklet (`source: "claude-code"` / `"codex"`), without needing real hooks configured for either.
- `research-collector-worker/` is deployed independently via `wrangler deploy`; see its `wrangler.jsonc` and `src/secrets.d.ts` for the two required secrets (`SUBMIT_KEY`, `GITHUB_TOKEN`).

## A note on unverified transcript parsing

Both `claude-code-plugin` and `codex-plugin` extract prompt text by parsing each agent's `transcript_path` JSONL file. `claude-code-plugin`'s parser has been checked against a real transcript; `codex-plugin`'s has not (see its own README) — if Codex-sourced Tasklets show up with an empty `build_prompt`, start there.
