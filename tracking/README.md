# Tracybot Tracking

[![Python](https://img.shields.io/badge/Python-3.8+-blue.svg?logo=python&style=flat-square)](https://www.python.org) [![Git](https://img.shields.io/badge/Git-2.28%2B_preferred-orange.svg?logo=git&style=flat-square)](https://git-scm.com)

Git hooks and scripts that track code state using hidden commits.

Most users should start from the [root README](../README.md), install the VS Code extension, and let it guide setup. This document focuses on how the tracking layer works and how to work on it directly.

## What It Does

The tracking component uses Git's internal mechanisms to store snapshots without polluting the visible commit history:

- Snapshots stored locally in `refs/tracy-local/*` (never pushed)
- Filtered chains promoted to `refs/tracy/*` on commit/rewrite (pushed to origin)
- Git notes on user commits to link them to their snapshot chain (`refs/notes/commits`)
- Remote notes tracked separately in `refs/notes/origin/commits` — fetch never overwrites local notes
- Git hooks for automatic tracking and notes sync

## How It Works

### `init.py`

`init.py` lives at the repository root, not inside `tracking/`.

When you run it against a target repository, it:

1. Finds the target Git repository from the current directory or an explicit path argument
2. Writes `.git/tracybot/config` with the path to `tracking/tracy.py`
3. Configures Git notes rewriting for `refs/notes/commits`
4. Adds Tracybot fetch and push refspecs when an `origin` remote exists
5. Installs seven hook entrypoints into `.git/hooks/` and copies the tracked Python hook implementations alongside them as `.tracy` files

### `tracy.py`

Invoked by the OpenCode plugin after each AI interaction and by the `pre-commit` hook for staged snapshots. It:

1. Captures the current working tree, or the staged index when `--index-only` is used
2. Generates or reuses a Tracy ID stored in `git config tracy.current-id`
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

## CLI Reference

### `init.py`

`init.py` accepts either:

- No argument, when run from inside the target Git repository
- A path argument pointing anywhere inside the target Git repository

Examples:

```bash
python /path/to/tracybot/init.py
python /path/to/tracybot/init.py /path/to/repository
```

### `tracy.py`

`tracy.py` is invoked directly by hooks and the OpenCode plugin. Its supported flags are:

- `--user-name <name>`
- `--user-email <email>`
- `--description <text>`
- `--session-id <id>`
- `--reset`
- `--index-only`
- `--debug`

Examples:

```bash
python /path/to/tracybot/tracking/tracy.py --debug
python /path/to/tracybot/tracking/tracy.py --index-only --debug
```

## Getting Started for Developers

### Initialize a Target Repository

```bash
python /path/to/tracybot/init.py /path/to/repository
```

If the target repository has no `origin` remote, local tracking still works. Remote note and ref synchronization is skipped until `origin` exists.

### Debug Snapshot Creation

From inside an initialized target repository:

```bash
python /path/to/tracybot/tracking/tracy.py --debug
python /path/to/tracybot/tracking/tracy.py --index-only --debug
```

## Troubleshooting

### Hidden refs not appearing

- Ensure `init.py` was run successfully in the repository
- Check that `.git/tracybot/config` exists
- Check that hooks are installed under `.git/hooks/`
- Verify Git config: `git config --list | grep tracy`

### Notes not syncing

- Check remote is configured: `git remote -v`
- Verify fetch/push refspecs include notes
- Try manually: `git fetch origin refs/notes/commits:refs/notes/origin/commits`

### Conflicts during sync

- Git notes use union strategy - conflicts concatenate rather than overwrite
- To resolve manually, edit the note: `git notes edit <commit-sha>`

### Hooks not firing

- Verify hook scripts are executable
- Check for hook override in git config: `git config core.hooksPath`
- Ensure Git version supports the hook (reference-transaction requires Git 2.28+)

## Requirements

- Git repository
- Python 3.8+
- Git 2.28+ is preferred; older versions rely on fallback hooks instead of `reference-transaction`
- Git hooks installed via the repo-root `init.py`
- `origin` is optional; it is only required for remote sync

## Related

- [Tracybot Root README](../README.md)
- [OpenCode Plugin](../opencode-plugin/README.md)
- [VS Code Extension](../vscode-extension/README.md)
