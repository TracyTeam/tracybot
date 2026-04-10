#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MOCK_DIR="$BASE_DIR/test/mock-repository"
REMOTE_DIR="$BASE_DIR/test/mock-remote.git"
TRACY_SCRIPT="$BASE_DIR/tracking/tracy.sh"
INIT_SCRIPT="$BASE_DIR/init.sh"

AI_NAME="big-pickle"
AI_EMAIL="OpenCode"

echo
echo "-------------------------------------"
echo "1. Creating repository"
echo "-------------------------------------"
echo

rm -rf "$MOCK_DIR"
rm -rf "$REMOTE_DIR"
mkdir -p "$MOCK_DIR"
mkdir -p "$REMOTE_DIR"
cd "$MOCK_DIR"

git init 2>/dev/null
git branch -m main 2>/dev/null
git config user.name "Thomas Turbando"
git config user.email "thomas@brazil.se"

git init --bare $REMOTE_DIR
git remote add origin $REMOTE_DIR

echo
echo "-------------------------------------"
echo "2. Initializing Tracybot"
echo "-------------------------------------"
echo

bash "$INIT_SCRIPT" .

ai_snapshot() {
    local prompt="$1"
    local file="$2"
    local content="$3"

    mkdir -p "$(dirname "$file")"
    echo -e "$content" >> "$file"
    
    bash "$TRACY_SCRIPT" --user-name "$AI_NAME" --user-email "$AI_EMAIL" --description "$prompt"
}

user_commit() {
    local msg="$1"
    local file="$2"
    local content="$3"

    mkdir -p "$(dirname "$file")"
    echo -e "$content" >> "$file"

    git add "$file"
    
    git commit -m "$msg"
}

user_snapshot() {
    local file="$1"
    local content="$2"

    mkdir -p "$(dirname "$file")"
    echo -e "$content" >> "$file"

    bash "$TRACY_SCRIPT"
}

echo
echo "-------------------------------------"
echo "3. Building History"
echo "-------------------------------------"
echo

# --- Main branch setup ---
user_commit "Init project root" "README.md" "# Mega Project\n"
ai_snapshot "Add global logging config" "backend/utils/logger.py" "import logging\nlogging.basicConfig(level=logging.DEBUG)"
ai_snapshot "Load env variables" "backend/utils/config.py" "import os\ndef get_env(k): return os.getenv(k)"
user_commit "Snapshot config for Tracybot" "backend/utils/config.py" "import os\ndef get_env(k): return os.getenv(k)"

# --- Feature 1: Auth Service (Squash + Rebase) ---
git checkout -b feature/auth main
ai_snapshot "JWT auth scaffolding" "backend/auth/jwt.py" "def gen_token(user): return 'jwt123'"
ai_snapshot "Password hashing" "backend/auth/hash.py" "import bcrypt\ndef hash_pw(pw): return bcrypt.hashpw(pw.encode(), bcrypt.gensalt())"
user_commit "Integrate auth with backend" "backend/app.py" "from auth.jwt import gen_token"
user_commit "Snapshot auth hash for Tracybot" "backend/auth/hash.py" "import bcrypt\ndef hash_pw(pw): return bcrypt.hashpw(pw.encode(), bcrypt.gensalt())  # snapshot"

git reset $(git merge-base main feature/auth)
git add -A
git commit -m "Squashed Auth Service"
git rebase main
git checkout main
git merge --ff-only feature/auth

# --- Feature 2: API Service (Normal Merge) ---
git checkout -b feature/api main
ai_snapshot "User endpoints" "backend/api/user.py" "@app.route('/user')\ndef get_user(): return {}"
ai_snapshot "Billing endpoints" "backend/api/billing.py" "@app.route('/billing')\ndef billing(): return {}"
user_commit "Add API docs" "docs/api.md" "# API Overview"
ai_snapshot "Refactor API with Blueprints" "backend/api/__init__.py" "from flask import Blueprint\napi_bp = Blueprint('api', __name__)"
user_commit "Snapshot API init for Tracybot" "backend/api/__init__.py" "from flask import Blueprint\napi_bp = Blueprint('api', __name__)  # snapshot"

git checkout main
git merge feature/api --no-edit || true
if git ls-files -u | grep -q .; then
    git add -A
    git commit -m "Auto-resolve merge conflicts for API Service"
fi

# --- Feature 3: Frontend UI (Rebase Only) ---
git checkout -b feature/frontend-ui main
ai_snapshot "React scaffolding" "frontend/src/App.jsx" "export default function App() { return <div>Hello</div>; }"
ai_snapshot "Add login page" "frontend/src/Login.jsx" "export default function Login() { return <form>Login</form> }"
user_commit "Add CSS styling" "frontend/src/styles.css" "body { font-family: sans-serif; }"
ai_snapshot "Add frontend tests" "frontend/tests/Login.test.jsx" "test('renders login', () => {})"
user_commit "Snapshot Login page for Tracybot" "frontend/src/Login.jsx" "export default function Login() { return <form>Login v2</form> }"

git checkout feature/frontend-ui
git rebase main || git rebase --abort
git checkout main
git merge --ff-only feature/frontend-ui

# --- Feature 4: Analytics Service (Squash + Merge) ---
git checkout -b feature/analytics main
ai_snapshot "ETL script scaffolding" "analytics/etl.py" "def run(): pass"
ai_snapshot "Data validation" "analytics/validate.py" "def validate(): pass"
user_commit "Add analytics README" "analytics/README.md" "# Analytics Service"
user_commit "Snapshot analytics validate for Tracybot" "analytics/validate.py" "def validate(): pass  # snapshot"

git reset $(git merge-base main feature/analytics)
git add -A
git commit -m "Squashed Analytics Service"
git checkout main
git merge feature/analytics --no-edit || true
if git ls-files -u | grep -q .; then
    git add -A
    git commit -m "Auto-resolve merge conflicts for Analytics Service"
fi

# --- Feature 5: Infrastructure (Normal Merge) ---
git checkout -b feature/infra main
ai_snapshot "Dockerfile backend" "infra/Dockerfile.backend" "FROM python:3.11\nWORKDIR /app"
ai_snapshot "Dockerfile frontend" "infra/Dockerfile.frontend" "FROM node:20\nWORKDIR /app"
ai_snapshot "CI workflow" "infra/.github/workflows/ci.yml" "name: CI\non: [push]\njobs:\n build: {}"
user_commit "Snapshot backend Dockerfile for Tracybot" "infra/Dockerfile.backend" "FROM python:3.11\nWORKDIR /app  # snapshot"

git checkout main
git merge feature/infra --no-edit || true
if git ls-files -u | grep -q .; then
    git add -A
    git commit -m "Auto-resolve merge conflicts for Infra"
fi

# --- Feature 6: Notifications Service (Rebase + FF) ---
git checkout -b feature/notifications main
ai_snapshot "Email notifications" "backend/notifications/email.py" "def send_email(to, subj, body): pass"
ai_snapshot "SMS notifications" "backend/notifications/sms.py" "def send_sms(number, msg): pass"
user_commit "Integrate notifications" "backend/auth/notify.py" "from notifications.email import send_email"
user_commit "Snapshot email notifications for Tracybot" "backend/notifications/email.py" "def send_email(to, subj, body): print(f'Sending email to {to}')"

git checkout feature/notifications
git rebase main || git rebase --abort
git checkout main
git merge --ff-only feature/notifications

# --- Feature 7: Payments Service (Squash + Rebase) ---
git checkout -b feature/payments main
ai_snapshot "Stripe integration" "backend/payments/stripe.py" "def charge(card, amount): pass"
user_commit "Add payment tests" "backend/tests/payments_test.py" "def test_charge(): pass"
user_commit "Snapshot payments tests for Tracybot" "backend/tests/payments_test.py" "def test_charge(): assert True"

git reset $(git merge-base main feature/payments)
git add -A
git commit -m "Squashed Payments Service"
git rebase main
git checkout main
git merge --ff-only feature/payments

# --- Feature 8: Frontend Enhancements (Rebase + FF) ---
git checkout -b feature/frontend-enhance main
ai_snapshot "Add dashboard page" "frontend/src/Dashboard.jsx" "export default function Dashboard() { return <div>Dashboard</div>; }"
user_commit "Add responsive layout" "frontend/src/styles.css" "body { margin: 0; } .container { max-width: 1200px; }"
user_commit "Snapshot dashboard page for Tracybot" "frontend/src/Dashboard.jsx" "export default function Dashboard() { return <div>Dashboard v2</div>; }"

git checkout feature/frontend-enhance
git rebase main || git rebase --abort
git checkout main
git merge --ff-only feature/frontend-enhance

# --- Feature 9: Analytics Improvements (Squash + Merge) ---
git checkout -b feature/analytics-improve main
ai_snapshot "Add logging to ETL" "analytics/etl.py" "def run(): print('ETL running')"
user_commit "Add sample analytics data" "analytics/sample_data.csv" "id,value\n1,100\n2,200"
user_commit "Snapshot analytics sample data for Tracybot" "analytics/sample_data.csv" "id,value\n1,100\n2,200\n3,300"

git reset $(git merge-base main feature/analytics-improve)
git add -A
git commit -m "Squashed Analytics Improvements"
git checkout main
git merge feature/analytics-improve --no-edit || true
if git ls-files -u | grep -q .; then
    git add -A
    git commit -m "Auto-resolve merge conflicts for Analytics Improvements"
fi

# --- Feature 10: Infra Updates (Normal Merge) ---
git checkout -b feature/infra-updates main
ai_snapshot "Add Nginx config" "infra/nginx.conf" "server { listen 80; }"
user_commit "Update CI workflow with tests" "infra/.github/workflows/ci.yml" "jobs:\n  build:\n    steps:\n      - run: pytest"
user_commit "Snapshot CI workflow for Tracybot" "infra/.github/workflows/ci.yml" "jobs:\n  build:\n    steps:\n      - run: pytest\n      - run: lint"

git checkout main
git merge feature/infra-updates --no-edit || true
if git ls-files -u | grep -q .; then
    git add -A
    git commit -m "Auto-resolve merge conflicts for Infra Updates"
fi

# --- Feature 11-15: Mini features for bigger history ---
for i in {11..15}; do
    branch="feature/mini-$i"
    git checkout -b "$branch" main
    user_commit "Add mini feature $i" "mini/feature$i.txt" "Content for mini feature $i"
    ai_snapshot "Snapshot mini feature $i" "mini/feature$i.snapshot" "Snapshot content $i"

    # Randomly choose merge strategy
    if (( i % 3 == 0 )); then
        git reset $(git merge-base main "$branch")
        git add -A
        git commit -m "Squashed mini feature $i"
        git rebase main
        git checkout main
        git merge --ff-only "$branch"
    elif (( i % 3 == 1 )); then
        git checkout main
        git merge "$branch" --no-edit || true
        if git ls-files -u | grep -q .; then
            git add -A
            git commit -m "Auto-resolve merge conflicts for mini feature $i"
        fi
    else
        git checkout "$branch"
        git rebase main || git rebase --abort
        git checkout main
        git merge --ff-only "$branch"
    fi
done

echo
echo "-------------------------------------"
echo -e "Mock Generation Complete"
echo "-------------------------------------"
echo
echo "Visible Commits: $(git rev-list --count HEAD)"
echo "Active Branches: $(git branch)"
echo "Tracy Snapshots (Refs): $(git show-ref | grep refs/tracy | wc -l)"
