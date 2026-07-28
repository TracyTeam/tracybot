#!/usr/bin/env bash
# Creates a throwaway repo at test/codex-mock with one AI Tasklet in the
# codex-plugin's JSON shape (source: "codex", flat prompt/response) — lets
# buildHistory.ts's polymorphic parsing be tested without configuring real
# Codex CLI hooks.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$(dirname "$SCRIPT_DIR")"
MOCK_DIR="$BASE_DIR/test/codex-mock"

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
  "id": "codex_demo-session_${NOW_MS}",
  "sessionId": "demo-session",
  "source": "codex",
  "model": "openai/gpt-5-codex",
  "prompt": "add a function that checks if a number is even",
  "response": "Added is_even() to utils.py.",
  "promptCreatedAt": ${NOW_MS},
  "responseCompletedAt": $((NOW_MS + 3000))
}
EOF
)

cat >> utils.py <<'PYEOF'

def is_even(n):
    return n % 2 == 0
PYEOF

python3 "$BASE_DIR/tracking/tracy.py" \
  --user-name "codex" \
  --user-email "codex" \
  --description "$TURN_JSON" \
  --session-id "demo-session"

git add utils.py
git commit -q -m "Add is_even"

echo "Mock repo ready at: $MOCK_DIR"
echo "Open this folder in the Extension Development Host and run 'Tracybot: Open AI Blame window' on utils.py"
