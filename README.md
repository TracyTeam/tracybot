# Tracybot

Tracybot is a tool that traces AI-generated code back to the prompts that created it. It enables tracking for AI-assisted development by recording snapshots of your codebase at each AI interaction.

## Goal

Provide complete traceability between AI-generated code changes and the prompts that produced them, enabling developers to understand, audit, and verify AI-assisted work.

## Architecture

Tracybot consists of three components that work together:
- **[opencode-plugin](./opencode-plugin/README.md)** - Plugin for opencode CLI that records snapshots during AI interactions
- **[vscode-extension](./vscode-extension/README.md)** - VS Code extension to view AI blame information
- **[tracking](./tracking/README.md)** - Git hooks and scripts for state tracking using hidden commits

```
┌──────────────────┐     ┌──────────────────┐     ┌───────────────────┐
│  opencode-plugin │────▶│  tracking/hooks  │◀────│  vscode-extension │
│  (snapshots AI)  │     │    + tracy.sh    │     │  (displays blame) │
│  (interactions)  │     │  (stores state)  │     │                   │
└──────────────────┘     └──────────────────┘     └───────────────────┘
```

### How Components Communicate

1. **opencode-plugin** invokes **`tracy.sh`** (from `tracking/`) after each AI interaction to create a snapshot
2. **`tracy.sh`** stores snapshots as hidden commits in the Git repository (using `refs/tracy/*` namespace)
3. **vscode-extension** queries Git to build a history timeline and displays blame information in VS Code

## Quick Getting Started

### 1. Initialize a Repository

```bash
cd your-target-repository
/path/to/tracybot/init.sh
```

This requires:
- A Git repository
- An `origin` remote configured

### 2. Deploy the Plugin

```bash
cd opencode-plugin
bun run deploy
```

### 3. Run the VS Code Extension

Open `vscode-extension/src/extension.ts` in VS Code and press **F5** to launch the extension debugger.