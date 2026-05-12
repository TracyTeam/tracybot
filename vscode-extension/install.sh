#!/usr/bin/env bash
set -e

TMP_DIR=$(mktemp -d)
VSIX_PATH="$TMP_DIR/tracy.vsix"

trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading latest Tracy extension..."
curl -fsSL -o "$VSIX_PATH" https://github.com/TracyTeam/tracybot/releases/latest/download/vscode-extension.vsix

echo "Installing extension in VS Code..."
code --install-extension "$VSIX_PATH"

echo "Tracy extension installed successfully!"
