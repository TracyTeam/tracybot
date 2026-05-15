# Tracybot OpenCode Plugin

An OpenCode plugin that records snapshots of your codebase after each AI interaction.

## What It Does

The plugin intercepts AI responses and invokes the Tracy tracking system to create hidden Git commits that preserve the state of your code before and after each agent interaction. 

If you are using Tracybot normally, install the [VS Code extension](../vscode-extension/README.md) first. It can prompt to install this plugin globally or for the current project. Manual installation methods are also provided below.

## Features

- Automatic snapshots after each AI interaction
- Captures working tree state via `tracy.py`
- Creates hidden commits in `refs/tracy-local/*` namespace
- Seamless integration with OpenCode CLI

## How It Works

1. After each AI response, the plugin calls `tracy.py` from the tracking component
2. `tracy.py` creates a hidden commit using Git's ref namespace (`refs/tracy-local/*`)
3. These commits are never visible in normal Git history but can be queried by the VS Code extension

## Installation

### Recommended: install from VS Code

After installing the Tracybot VS Code extension, open a workspace and accept the prompt to install the OpenCode plugin.

The extension can install the plugin either:

- Globally at `~/.config/opencode/plugin/tracybot-oc.js`
- Per project at `.opencode/plugin/tracybot-oc.js`

### Install the latest released plugin directly

#### Linux and macOS

```bash
curl -fsSL https://raw.githubusercontent.com/TracyTeam/tracybot/main/opencode-plugin/install.sh | bash
```

#### Windows

```powershell
irm https://raw.githubusercontent.com/TracyTeam/tracybot/main/opencode-plugin/install.ps1 | iex
```

## Usage

Once installed, the plugin runs inside OpenCode and calls `tracy.py` automatically for tracked AI interactions. The plugin does not require any additional interactions.

## Getting Started for Developers

### Install Dependencies

```bash
bun install
```

### Build the Plugin

```bash
bun run build
```

### Deploy the Plugin from Source

```bash
bun run deploy
```

This builds the plugin and installs `dist/tracybot-oc.js` into the global OpenCode plugin directory `~/.config/opencode/plugin`.

### Install a Project-Local Build Manually
If you wish to install the plugin to only be active in a repository instead of globally, it can be installed into a project's `.opencode` directory.
```bash
bun run build
mkdir -p /path/to/repo/.opencode/plugin
cp dist/tracybot-oc.js /path/to/repo/.opencode/plugin/
```

### View Logs
To view the plugin logs from the latest OpenCode run:
```bash
bun run logs
```

## Troubleshooting

### Plugin not loading

- Verify the plugin file exists at `~/.config/opencode/plugin/tracybot-oc.js`
- If you installed per project, verify it exists at `.opencode/plugin/tracybot-oc.js`
- Check OpenCode logs: `bun run logs`. On successful plugin startup, there will be a "Plugin Initialized" message
- Ensure the repository was initialized with `init.py`

### Snapshots not being created

- Check that `.git/tracybot/config` exists in the target repository and points to a valid `tracy.py`
- Verify Git hooks are installed in the target repository
- Check for errors in the plugin logs

### Permission errors

- Ensure write permissions on `~/.config/opencode/`
- On Linux, you may need to create the config directory first

## Requirements

- OpenCode CLI installed
- A repository initialized with the repo-root `init.py`
- Python available to run `tracy.py` inside the target repository

You only need Bun when building or deploying the plugin from source.

## Related

- [Tracybot Root README](../README.md)
- [Tracking Component](../tracking/README.md)
- [VS Code Extension](../vscode-extension/README.md)
