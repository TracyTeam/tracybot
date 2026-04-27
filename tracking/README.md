# Tracybot Tracking

Git hooks and scripts that track code state using hidden commits.

## What It Does

The tracking component uses Git's internal mechanisms to store snapshots without polluting the visible commit history:
- Snapshots stored locally in `refs/tracy-local/*` (never pushed)
- Filtered chains promoted to `refs/tracy/*` on commit/rewrite (pushed to origin)
- Git notes on user commits to link them to their snapshot chain
- Git hooks (pre-commit, post-commit, post-rewrite) for automatic tracking

## How It Works

### `tracy.sh`

Invoked by the opencode-plugin after each AI interaction. It:
1. Captures the current working tree (or staged index with `--index-only`) into a temporary Git index
2. Generates or reuses a Tracy ID (UUID stored in `git config tracy.current-id`)
3. Creates a hidden commit as a child of the previous snapshot in `refs/tracy-local/<UUID>`

### Git Hooks

`init.sh` installs three hooks:

- **`pre-commit`** — calls `tracy.sh --index-only` to snapshot exactly what is staged before the commit lands
- **`post-commit`** — promotes the local snapshot chain to `refs/tracy/<UUID>`, keeping only files that were actually in the commit; attaches a `tracy-id` note to the commit; cleans up the local ref
- **`post-rewrite`** — handles commit rewrites:
  - **amend**: combines the pre-amend chain with the newly created post-commit chain into one
  - **rebase** (one-to-one): recreates the chain under a fresh ID for the new commit SHA
  - **squash**: merges all chains from the squashed commits into a single chain

## Usage

Typically, you don't run tracking components directly. Instead:

1. Run `./init.sh` in your target repository to install hooks and configure Git
2. The opencode-plugin will invoke `tracy.sh` automatically during AI interactions
3. The VS Code extension will query the tracking data

## Requirements

- Git repository with an origin remote configured
- Git hooks must be installed via `./init.sh`
