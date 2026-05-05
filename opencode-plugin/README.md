# Tracybot OpenCode Plugin

An OpenCode plugin that records snapshots of your codebase after each AI interaction.

## What It Does

The plugin intercepts AI responses and invokes the Tracy tracking system to create hidden Git commits that preserve the state of your code at the moment of each AI interaction.

## How It Works

1. After each AI response, the plugin calls `tracy.py` from the tracking component
2. `tracy.py` creates a hidden commit using Git's ref namespace (`refs/tracy-local/*`)
3. These commits are never visible in normal Git history but can be queried by the VS Code extension

## Usage

### Deploy the Plugin

```bash
bun run deploy
```

This deploys the plugin to make it available for OpenCode.

### Run Locally (Development)

```bash
bun run index.ts
```

## Requirements

- Bun runtime
- A repository initialized with `init.py` (from the Tracybot root)