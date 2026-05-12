#!/usr/bin/env bash
set -e

PLUGIN_DIR="$HOME/.config/opencode/plugin"
DEST_PATH="$PLUGIN_DIR/tracybot-oc.js"
ASSET_URL="https://github.com/TracyTeam/tracybot/releases/latest/download/tracybot-oc.js"

TMP_DIR=$(mktemp -d)
TMP_FILE="$TMP_DIR/tracybot-oc.js"

trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading latest OpenCode Tracy plugin..."
curl -fsSL -o "$TMP_FILE" "$ASSET_URL"

echo "Ensuring plugin directory exists ($PLUGIN_DIR)..."
mkdir -p "$PLUGIN_DIR"

echo "Installing plugin..."
mv -f "$TMP_FILE" "$DEST_PATH"

echo "OpenCode Tracy plugin installed successfully!"
