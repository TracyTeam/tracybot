#!/usr/bin/env bash
# Creates a throwaway repo at test/claude-code-mock with one AI Tasklet in the
# claude-code-plugin's JSON shape (source: "claude-code", flat prompt/response,
# no Plan/Build split) — lets buildHistory.ts's polymorphic parsing be tested
# without configuring real Claude Code hooks.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$(dirname "$SCRIPT_DIR")"
MOCK_DIR="$BASE_DIR/test/claude-code-mock"

rm -rf "$MOCK_DIR"
mkdir -p "$MOCK_DIR"
cd "$MOCK_DIR"

git init -q
git branch -m main
git config user.name "Dev Tester"
git config user.email "dev@example.com"

python3 "$BASE_DIR/init.py" .

echo "def handler(request):" > utils.py
echo "    return request" >> utils.py
git add utils.py
git commit -q -m "Init project"

NOW_MS=$(($(date +%s) * 1000))
TURN_JSON=$(cat <<EOF
{
  "id": "claude_demo-session_${NOW_MS}",
  "sessionId": "demo-session",
  "source": "claude-code",
  "model": "anthropic/claude-sonnet-4-6",
  "prompt": "add a function that reverses a string",
  "response": "Added reverse_string() to utils.py using slicing.",
  "promptCreatedAt": ${NOW_MS},
  "responseCompletedAt": $((NOW_MS + 4000))
}
EOF
)

cat >> utils.py <<'PYEOF'

def reverse_string(s):
    return s[::-1]
PYEOF

python3 "$BASE_DIR/tracking/tracy.py" \
  --user-name "claude-code" \
  --user-email "claude-code" \
  --description "$TURN_JSON" \
  --session-id "demo-session"

git add utils.py
git commit -q -m "Add reverse_string"

echo "Mock repo ready at: $MOCK_DIR"
echo "Open this folder in the Extension Development Host and run 'Tracybot: Open AI Blame window' on utils.py"
