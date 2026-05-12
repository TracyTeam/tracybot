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
┌───────────────────┐     ┌──────────────────┐     ┌────────────────────┐
│  opencode-plugin  │────▶│  tracking/hooks  │◀────│  vscode-extension  │
│  (snapshots AI)   │     │     tracy.py     │     │  (displays blame)  │
│  (interactions)   │     │  (stores state)  │     │                    │
└───────────────────┘     └──────────────────┘     └────────────────────┘
```

### How Components Communicate

1. **opencode-plugin** invokes **`tracy.py`** (from `tracking/`) after each AI interaction to create a snapshot
2. **`tracy.py`** stores snapshots as hidden commits in the Git repository (using `refs/tracy-local/*` namespace)
3. **vscode-extension** queries Git to build a history timeline and displays blame information in VS Code

## Quick Getting Started

### 1. Initialize a Repository

```bash
cd your-target-repository
python /path/to/tracybot/init.py
```

This requires:
- A Git repository
- An `origin` remote configured

### 2. Deploy the Plugin

```bash
cd opencode-plugin
bun run deploy
```

### 3. Install the VSCode Extension

#### Automated installation (recommended)

##### Linux & macOS

In the terminal, run
```bash
curl -fsSL https://raw.githubusercontent.com/TracyTeam/tracybot/main/vscode-extension/install.sh | bash
```

##### Windows

In Powershell, run
```powershell
powershell -Command "irm https://raw.githubusercontent.com/TracyTeam/tracybot/main/install.ps1 | iex"
```

#### Manual installation

Alternatively, the extension can be installed manually.

1. Download the packaged extension
```bash
curl -fsSL -o tracy.vsix https://github.com/TracyTeam/tracybot/releases/latest/download/vscode-extension.vsix
```

or from the [latest release](https://github.com/TracyTeam/tracybot/releases/latest)

2. In VSCode, go to `EXTENSIONS tab --> Click on the 3 dots --> Install from vsix` and choose the downloaded .vsix file

### 4. Install the OpenCode Plugin

If you wish to use the Tracybot OpenCode integration, the OpenCode plugin needs to be installed.

#### From VSCode

If the VSCode extension is installed, you will be prompted to install the plugin if it was not yet installed.
You may choose to install it globally (global OpenCode plugin directory), or per project (.opencode directory in the project).

#### Automated Installation

To install the plugin from the terminal, run:

##### Linux & macOS
```bash
curl -fsSL https://raw.githubusercontent.com/TracyTeam/tracybot/main/opencode-plugin/install.sh | bash
```

##### Windows
```powershell
powershell -Command "irm https://raw.githubusercontent.com/TracyTeam/tracybot/main/opencode-plugin/install.sh | iex"
```

