#!/usr/bin/env python3
import os
import shutil
import subprocess
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
BASE_DIR = SCRIPT_DIR.parent
MOCK_DIR = BASE_DIR / "test/mock-repository"
REMOTE_DIR = BASE_DIR / "test/mock-remote.git"
TRACY_SCRIPT = BASE_DIR / "tracking/tracy.sh"
INIT_SCRIPT = BASE_DIR / "init.sh"

AI_NAME = "big-pickle"
AI_EMAIL = "OpenCode"


def run(cmd, cwd=None, check=True, capture=False):
    result = subprocess.run(
        cmd,
        cwd=cwd,
        text=True,
        capture_output=capture
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"Command failed: {' '.join(cmd)}")
    return result.stdout.strip() if capture else None


def echo_section(title, num):
    print("\n-------------------------------------")
    print(f"{num}. {title}")
    print("-------------------------------------\n")


# -------------------------------
# 1. CREATE REPO
# -------------------------------
echo_section("Creating repository", 1)

shutil.rmtree(MOCK_DIR, ignore_errors=True)
shutil.rmtree(REMOTE_DIR, ignore_errors=True)

MOCK_DIR.mkdir(parents=True, exist_ok=True)
REMOTE_DIR.mkdir(parents=True, exist_ok=True)

run(["git", "init"], cwd=MOCK_DIR)
run(["git", "branch", "-m", "main"], cwd=MOCK_DIR, check=False)

run(["git", "config", "user.name", "Thomas Turbando"], cwd=MOCK_DIR)
run(["git", "config", "user.email", "thomas@brazil.se"], cwd=MOCK_DIR)

run(["git", "init", "--bare", str(REMOTE_DIR)])
run(["git", "remote", "add", "origin", str(REMOTE_DIR)], cwd=MOCK_DIR)

# -------------------------------
# 2. INIT TRACYBOT
# -------------------------------
echo_section("Initializing Tracybot", 2)
run(["bash", str(INIT_SCRIPT), "."], cwd=MOCK_DIR)

# -------------------------------
# HELPERS
# -------------------------------
def ensure_file(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a") as f:
        f.write(content + "\n")


def ai_snapshot(prompt, file, content):
    file_path = MOCK_DIR / file
    ensure_file(file_path, content)

    run([
        "bash", str(TRACY_SCRIPT),
        "--user-name", AI_NAME,
        "--user-email", AI_EMAIL,
        "--description", prompt
    ], cwd=MOCK_DIR)


def user_commit(msg, file, content):
    file_path = MOCK_DIR / file
    ensure_file(file_path, content)

    run(["git", "add", file], cwd=MOCK_DIR)
    run(["git", "commit", "-m", msg], cwd=MOCK_DIR)


def user_snapshot(file, content):
    file_path = MOCK_DIR / file
    ensure_file(file_path, content)

    run(["bash", str(TRACY_SCRIPT)], cwd=MOCK_DIR)


# -------------------------------
# 3. BUILD HISTORY
# -------------------------------
echo_section("Building History", 3)

# Main
user_commit("Init project root", "README.md", "# Mega Project")
ai_snapshot("Add global logging config", "backend/utils/logger.py",
            "import logging\nlogging.basicConfig(level=logging.DEBUG)")
ai_snapshot("Load env variables", "backend/utils/config.py",
            "import os\ndef get_env(k): return os.getenv(k)")
user_commit("Snapshot config for Tracybot", "backend/utils/config.py",
            "import os\ndef get_env(k): return os.getenv(k)")

# Feature auth (squash + rebase)
run(["git", "checkout", "-b", "feature/auth", "main"], cwd=MOCK_DIR)
ai_snapshot("JWT auth scaffolding", "backend/auth/jwt.py", "def gen_token(user): return 'jwt123'")
ai_snapshot("Password hashing", "backend/auth/hash.py",
            "import bcrypt\ndef hash_pw(pw): return bcrypt.hashpw(pw.encode(), bcrypt.gensalt())")
user_commit("Integrate auth with backend", "backend/app.py", "from auth.jwt import gen_token")
user_commit("Snapshot auth hash for Tracybot", "backend/auth/hash.py",
            "import bcrypt\ndef hash_pw(pw): return bcrypt.hashpw(pw.encode(), bcrypt.gensalt())  # snapshot")

run(["git", "reset", run(["git", "merge-base", "main", "feature/auth"], cwd=MOCK_DIR, capture=True)], cwd=MOCK_DIR)
run(["git", "add", "-A"], cwd=MOCK_DIR)
run(["git", "commit", "-m", "Squashed Auth Service"], cwd=MOCK_DIR)
run(["git", "rebase", "main"], cwd=MOCK_DIR)
run(["git", "checkout", "main"], cwd=MOCK_DIR)
run(["git", "merge", "--ff-only", "feature/auth"], cwd=MOCK_DIR)

# Feature API (merge)
run(["git", "checkout", "-b", "feature/api", "main"], cwd=MOCK_DIR)
ai_snapshot("User endpoints", "backend/api/user.py", "@app.route('/user')\ndef get_user(): return {}")
ai_snapshot("Billing endpoints", "backend/api/billing.py", "@app.route('/billing')\ndef billing(): return {}")
user_commit("Add API docs", "docs/api.md", "# API Overview")
ai_snapshot("Refactor API with Blueprints", "backend/api/__init__.py",
            "from flask import Blueprint\napi_bp = Blueprint('api', __name__)")
user_commit("Snapshot API init for Tracybot", "backend/api/__init__.py",
            "from flask import Blueprint\napi_bp = Blueprint('api', __name__)  # snapshot")

run(["git", "checkout", "main"], cwd=MOCK_DIR)
run(["git", "merge", "feature/api", "--no-edit"], cwd=MOCK_DIR, check=False)

# Conflict resolution
if run(["git", "ls-files", "-u"], cwd=MOCK_DIR, capture=True):
    run(["git", "add", "-A"], cwd=MOCK_DIR)
    run(["git", "commit", "-m", "Auto-resolve merge conflicts for API Service"], cwd=MOCK_DIR)

# -------------------------------
# MINI FEATURES LOOP
# -------------------------------
for i in range(11, 16):
    branch = f"feature/mini-{i}"
    run(["git", "checkout", "-b", branch, "main"], cwd=MOCK_DIR)

    user_commit(f"Add mini feature {i}", f"mini/feature{i}.txt", f"Content for mini feature {i}")
    ai_snapshot(f"Snapshot mini feature {i}", f"mini/feature{i}.snapshot", f"Snapshot content {i}")

    if i % 3 == 0:
        base = run(["git", "merge-base", "main", branch], cwd=MOCK_DIR, capture=True)
        run(["git", "reset", base], cwd=MOCK_DIR)
        run(["git", "add", "-A"], cwd=MOCK_DIR)
        run(["git", "commit", "-m", f"Squashed mini feature {i}"], cwd=MOCK_DIR)
        run(["git", "rebase", "main"], cwd=MOCK_DIR)
        run(["git", "checkout", "main"], cwd=MOCK_DIR)
        run(["git", "merge", "--ff-only", branch], cwd=MOCK_DIR)

    elif i % 3 == 1:
        run(["git", "checkout", "main"], cwd=MOCK_DIR)
        run(["git", "merge", branch, "--no-edit"], cwd=MOCK_DIR, check=False)
        if run(["git", "ls-files", "-u"], cwd=MOCK_DIR, capture=True):
            run(["git", "add", "-A"], cwd=MOCK_DIR)
            run(["git", "commit", "-m", f"Auto-resolve merge conflicts for mini feature {i}"], cwd=MOCK_DIR)

    else:
        run(["git", "checkout", branch], cwd=MOCK_DIR)
        run(["git", "rebase", "main"], cwd=MOCK_DIR, check=False)
        run(["git", "checkout", "main"], cwd=MOCK_DIR)
        run(["git", "merge", "--ff-only", branch], cwd=MOCK_DIR)

# -------------------------------
# DONE
# -------------------------------
print("\n-------------------------------------")
print("Mock Generation Complete")
print("-------------------------------------\n")

visible = run(["git", "rev-list", "--count", "HEAD"], cwd=MOCK_DIR, capture=True)
branches = run(["git", "branch"], cwd=MOCK_DIR, capture=True)
tracy_refs = run(["bash", "-c", "git show-ref | grep refs/tracy | wc -l"], cwd=MOCK_DIR, capture=True)

print(f"Visible Commits: {visible}")
print(f"Active Branches:\n{branches}")
print(f"Tracy Snapshots (Refs): {tracy_refs}")