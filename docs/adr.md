# ADR drafts

Tracybot can turn a tasklet into an [Architecture Decision Record](https://adr.github.io/) draft. No LLM is involved: everything is either copied from what Tracybot recorded (redacted and shortened) or computed from the code. The parts that need judgment are left for you to write.

## Creating one

Open **AI Blame**, click a highlighted line, and press **Create ADR** on the tasklet card. Tracybot asks for a title (prefilled from the request, change it to name the decision), writes `docs/adr/NNNN-title.md`, and opens it. Fill in the `TODO` sections, review it, and commit it like any other file. The folder is the `tracybot.adrDirectory` setting (relative to the repository root); numbers continue from the highest one already there.

One ADR is made from one tasklet. Only tasklets that still own at least one line in AI Blame can be opened from the panel.

## What is in it

| Section | Source |
|---|---|
| Title, date, `status` | title you give, the tasklet's timestamp, computed (below) |
| Context | the request, any earlier discussion with the AI, and the AI's summary: excerpts only |
| Considered options, Decision outcome | the questions the AI asked and your answers, when the agent recorded them (**OpenCode only**; Claude Code and Codex say "not recorded") |
| Evidence | tasklet, session, commit, agent and model, and per file how many lines are in use or overwritten |
| Decision drivers, Consequences, Pros and cons, deciders, *why* | left as `TODO` for you |

## Status follows the code

`status` is computed from who owns the code today, not typed by anyone:

- `accepted`: the tasklet's code is in use and committed
- `proposed`: its code is in use but not committed yet
- `superseded`: none of its lines are in use any more (the line `tracybot-status-basis` says which later tasklets now own them, when there is one)

Run **Tracybot: Refresh ADR Status** to recompute it for every Tracybot ADR in the folder. It rewrites **only** the `status` and `tracybot-status-basis` lines of the front matter, never the text below, leaves a status you set by hand (`rejected`, `deprecated`, ...) alone, and skips a file with unsaved changes. Nothing is written when only the date has moved on.

"Superseded" means the lines were overwritten, which is a strong hint that the decision was replaced but not proof: a bug fix or refactor over the same lines also does it.

## Before you commit it

The excerpts are your actual prompts and the AI's replies. Fenced code blocks and home-directory paths are removed (the same rules Research Mode uses) and long messages are shortened, but **nothing else is filtered**: a link, a name or a secret you typed into a prompt will be copied. Read the draft before committing.
