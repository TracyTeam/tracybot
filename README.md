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

There are 3 different ways of using our extension

Option 1. Run

```bash
curl -Ls -o tracy.vsix https://github.com/TracyTeam/tracybot/releases/download/latest/tracybot-extension-0.0.1.vsix && code --install-extension tracy.vsix && rm tracy.vsix
```

Option 2. Manual install
1. Download packaged extension
```bash
curl -Ls -o tracy.vsix https://github.com/TracyTeam/tracybot/releases/download/latest/tracybot-extension-0.0.1.vsix
```
Then open VSCode and go to EXTENSIONS (left side) --> Click on the 3 dots --> Install from vsix and choose the downloaded .vsix file

