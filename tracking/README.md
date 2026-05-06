# Tracybot Tracking

Git hooks and scripts that track code state using hidden commits.

## What It Does

The tracking component uses Git's internal mechanisms to store snapshots without polluting the visible commit history:
- Hidden commits stored in `refs/tracy/*` namespace
- Git notes for metadata storage
- Git hooks (pre-commit, post-commit, post-rewrite) for automatic snapshot creation

## How It Works

### `tracy.sh`

This script is invoked by the opencode-plugin after each AI interaction. It:
1. Creates a temporary Git index with all current changes
2. Generates a unique Tracy ID for the session
3. Creates a hidden commit with the code state as a child of the previous snapshot
4. Stores the hidden commit reference in `refs/tracy/<UUID>`

### Git Hooks

The `init.sh` script installs three hooks:
- `pre-commit` - Creates a snapshot before each visible commit
- `post-commit` - Records metadata after commits
- `post-rewrite` - Handles rebases and amendments

## Usage

Typically, you don't run tracking components directly. Instead:

1. Run `./init.sh` in your target repository to install hooks and configure Git
2. The opencode-plugin will invoke `tracy.sh` automatically during AI interactions
3. The VS Code extension will query the tracking data

## Requirements

- Git repository with an origin remote configured
- Git hooks must be installed via `./init.sh`