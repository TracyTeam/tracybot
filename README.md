# Tracybot

[![GitHub Release](https://img.shields.io/github/v/release/TracyTeam/tracybot)](https://github.com/TracyTeam/tracybot/releases/latest) [![License](https://img.shields.io/github/license/TracyTeam/tracybot)](LICENSE) [![GitHub Workflow Status](https://img.shields.io/github/actions/workflow/status/TracyTeam/tracybot/release.yml)](https://github.com/TracyTeam/tracybot/actions)

![Representative](./public/representative.png)

Tracybot is a tool that traces AI-generated code back to the prompts that created it. It enables tracking for AI-assisted development by recording snapshots of your codebase at each AI interaction.

## Features

- **AI Traceability** - Map AI-generated lines of code back to their originating prompt
- **Non-Invasive Storage** - Hidden Git commits and refs keep your history clean
- **Seamless Integration** - Works with OpenCode CLI and Visual Studio Code
- **Audit Trail** - Review AI interactions to verify, debug, or understand code origins
- **Team Sync** - Push traces to remote for team collaboration

## Architecture

Tracybot consists of three components that work together:

- **[opencode-plugin](./opencode-plugin/README.md)** - Plugin for opencode CLI that records snapshots during AI interactions
- **[vscode-extension](./vscode-extension/README.md)** - VS Code extension to view AI blame information
- **[tracybot-tracking](./tracking/README.md)** - Git hooks and scripts for state tracking using hidden commits and synced git notes

More information, including the requirements that resulted in these architectural decisions, are on the [wiki](https://github.com/TracyTeam/tracybot/wiki/Architecture).

## Quick Start

### 1. Install the VS Code Extension

This is the recommended entry point. The extension can open AI Blame, prompt to initialize Tracybot in the current repository, and offer to install the OpenCode plugin.

#### Linux and macOS

```bash
curl -fsSL https://raw.githubusercontent.com/TracyTeam/tracybot/main/vscode-extension/install.sh | bash
```

#### Windows

```powershell
irm https://raw.githubusercontent.com/TracyTeam/tracybot/main/vscode-extension/install.ps1 | iex
```

The install scripts use the `code` CLI, so make sure the VS Code command line tools are available first.

### 2. Open Your Repository in VS Code

When the extension activates, it adds an `AI Blame` status bar item on the right side of VS Code.

If Tracybot has not been initialized in that repository yet, the extension offers to run initialization for you.

If you prefer to initialize from the terminal instead, run:

```bash
python /path/to/tracybot/init.py /path/to/your-target-repository
```

Requirements:
- A Git repository
- Python 3 available as `python3` or `python`
- An `origin` remote is optional; it is only needed for syncing Tracy refs and notes with a remote

### 3. Install the OpenCode Plugin

If the VS Code extension is installed, it will prompt you to install the OpenCode plugin when it is missing.

You can install it either:
- Globally at `~/.config/opencode/plugin/tracybot-oc.js`
- Per project at `.opencode/plugin/tracybot-oc.js`

If you want to install the released plugin directly from the terminal instead of using the VS Code prompt:

#### Linux and macOS

```bash
curl -fsSL https://raw.githubusercontent.com/TracyTeam/tracybot/main/opencode-plugin/install.sh | bash
```

#### Windows

```powershell
irm https://raw.githubusercontent.com/TracyTeam/tracybot/main/opencode-plugin/install.ps1 | iex
```

### 4. Start Using AI Blame

After OpenCode makes changes in an initialized repository, Tracybot records snapshots automatically. Click `AI Blame` in VS Code to inspect the prompt history behind the current file.

## Troubleshooting

### Common Issues

**No AI blame information showing**
- Ensure the repository was initialized with `init.py`
- Verify VS Code extension is installed
- Check that OpenCode has already produced tracked changes in this repository

**Snapshots not being created**
- Check that the OpenCode plugin is installed and loaded
- Verify Tracybot was initialized successfully in the repository
- Verify Git hooks are installed under `.git/hooks/`
- Check for errors in the OpenCode output

**Push sync not working**
- Ensure an `origin` remote is configured
- Check that the `pre-push` hook is installed
- Verify Git notes are being pushed

## Getting Started for Developers

### Initialize a Repository Manually

```bash
python ./init.py /path/to/target-repository
```

If you run `init.py` from inside a Git repository, you can omit the explicit path.

### Work on the VS Code Extension

```bash
cd vscode-extension
npm install
npm run compile
```

Open `vscode-extension` in VS Code and press `F5` to launch the extension host.

### Work on the OpenCode Plugin

```bash
cd opencode-plugin
bun install
bun run deploy
```

`bun run deploy` builds the plugin and installs it into the global OpenCode plugin directory.

### Manual Installation from Release Assets

If you are testing packaging or release artifacts manually:

1. Download `vscode-extension.vsix` from the [latest release](https://github.com/TracyTeam/tracybot/releases/latest) and install it with `code --install-extension vscode-extension.vsix` or VS Code's `Install from VSIX...` action.
2. Download `tracybot-oc.js` from the same release and place it in either `~/.config/opencode/plugin/` or `<repo>/.opencode/plugin/`.
