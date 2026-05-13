# Tracybot Tracking

Git hooks and scripts that track code state using hidden commits.

## What It Does

The tracking component uses Git's internal mechanisms to store snapshots without polluting the visible commit history:
- Snapshots stored locally in `refs/tracy-local/*` (never pushed)
- Filtered chains promoted to `refs/tracy/*` on commit/rewrite (pushed to origin)
- Git notes on user commits to link them to their snapshot chain (`refs/notes/commits`)
- Remote notes tracked separately in `refs/notes/origin/commits` — fetch never overwrites local notes
- Git hooks for automatic tracking and notes sync

## How It Works

### `tracy.py`

Invoked by the opencode-plugin after each AI interaction. It:
1. Captures the current working tree (or staged index with `--index-only`) into a temporary Git index
2. Generates or reuses a Tracy ID (UUID stored in `git config tracy.current-id`)
3. Creates a hidden commit as a child of the previous snapshot in `refs/tracy-local/<UUID>`

### Git Notes Sync

Git notes behave like branches: local and remote copies are kept separate and merged explicitly.

- **`refs/notes/commits`** — local notes (analogous to a local branch)
- **`refs/notes/origin/commits`** — remote-tracking notes, updated by `git fetch` (analogous to `refs/remotes/origin/<branch>`)

The fetch refspec `+refs/notes/*:refs/notes/origin/*` ensures `git fetch` never overwrites local notes. Merging the remote-tracking ref into local uses `--strategy=union`, so notes present on only one side are always preserved and conflicting notes are concatenated rather than discarded.

### Git Hooks

`init.py` installs seven hooks:

- **`pre-commit`** — calls `tracy.py --index-only` to snapshot exactly what is staged before the commit lands
- **`post-commit`** — promotes the local snapshot chain to `refs/tracy/<UUID>`, keeping only files that were actually in the commit; attaches a `tracy-id` note to the commit; cleans up the local ref
- **`post-rewrite`** — handles commit rewrites:
  - **amend**: combines the pre-amend chain with the newly created post-commit chain into one
  - **rebase** (one-to-one): recreates the chain under a fresh ID for the new commit SHA
  - **squash**: merges all chains from the squashed commits into a single chain
- **`post-fetch`** — repairs `remote.origin.fetch` rules if they were removed and re-fetches; merges `refs/notes/origin/commits` into local notes; skips silently if no origin remote exists
- **`reference-transaction`** *(git ≥ 2.28)* — fires immediately after any ref transaction commits; when a fetch updates `refs/notes/origin/commits`, merges it into local notes right away — this is the primary merge trigger for standalone `git fetch`
- **`post-merge`** — merges `refs/notes/origin/commits` into local notes after `git merge` / `git pull`; acts as a fallback for git < 2.28 where `reference-transaction` is unavailable
- **`pre-push`** — before each push: fetches the latest remote notes into `refs/notes/origin/commits`, merges them into local (preventing overwrite of concurrent remote changes), then lets the configured push refspec push the merged notes to origin; skips silently if no origin remote exists

## Usage

Typically, you don't run tracking components directly. Instead:

1. Run `init.py` in your target repository to install hooks and configure Git
2. The opencode-plugin will invoke `tracy.py` automatically during AI interactions
3. The VS Code extension will query the tracking data

## Requirements

- Git repository (origin remote is optional — tracking works without it, but push/fetch sync is skipped)
- Git hooks must be installed via `init.py`
