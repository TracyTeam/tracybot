#!/usr/bin/env bash
# Creates a throwaway repo at test/research-mode-mock with one AI Tasklet in
# the modern JSON format (id, sessionId, planOutputs, buildOutput with
# timestamps) — the format opencode-plugin actually produces, unlike
# generate-mock-repository.py's plain-string descriptions which predate
# Research Mode and have no taskletId for buildResearchPayloads to key on.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$(dirname "$SCRIPT_DIR")"
MOCK_DIR="$BASE_DIR/test/research-mode-mock"

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
TASKLET_JSON=$(cat <<EOF
{
  "id": "tasklet_demo-session_${NOW_MS}",
  "sessionId": "demo-session",
  "title": "Add a rate limiter helper",
  "planOutputs": [
    {
      "id": "plan_0",
      "model": "anthropic/claude-sonnet-4-6",
      "prompt": "Add a simple rate limiter to the request handler",
      "response": "I will add a token-bucket style rate limiter as a new function in utils.py.",
      "promptCreatedAt": ${NOW_MS},
      "responseCompletedAt": $((NOW_MS + 5000))
    }
  ],
  "buildOutput": {
    "id": "build_1",
    "model": "anthropic/claude-sonnet-4-6",
    "prompt": "looks good, go ahead",
    "response": "Done — added rate_limit() to utils.py.",
    "promptCreatedAt": $((NOW_MS + 10000)),
    "responseCompletedAt": $((NOW_MS + 15000))
  },
  "questions": []
}
EOF
)

cat >> utils.py <<'PYEOF'

def rate_limit(user_id):
    # naive token bucket, replace with real implementation
    return True
PYEOF

python3 "$BASE_DIR/tracking/tracy.py" \
  --user-name "opencode" \
  --user-email "opencode" \
  --description "$TASKLET_JSON" \
  --session-id "demo-session"

git add utils.py
git commit -q -m "Add rate limiter"

echo "Mock repo ready at: $MOCK_DIR"
echo "Open this folder in the Extension Development Host and run 'Tracybot: Open AI Blame window' on utils.py"
