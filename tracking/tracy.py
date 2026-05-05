import os
import sys
import subprocess
import tempfile
import shutil
import uuid

REF_BASE = "refs/tracy-local"
USER_NAME = ""
USER_EMAIL = ""
DESCRIPTION = ""
SESSION_ID = ""
RESET_ID = False
INDEX_ONLY = False
DEBUG = False


def run_git(args, capture_output=False, check=False, cwd=None):
    try:
        result = subprocess.run(
            ["git"] + args,
            text=True,
            stdout=subprocess.PIPE if capture_output else None,
            stderr=subprocess.DEVNULL,
            check=check,
            cwd=cwd
        )
        if capture_output:
            return result.stdout.strip()
        return result.returncode == 0
    except subprocess.CalledProcessError:
        return None if capture_output else False


# -------------------------------
# ARG PARSING
# -------------------------------
args = sys.argv[1:]
REPO_ROOT = run_git(["rev-parse", "--show-toplevel"], capture_output=True) or os.getcwd()
i = 0
while i < len(args):
    arg = args[i]

    if arg == "--user-name":
        USER_NAME = args[i + 1]
        i += 2
    elif arg == "--user-email":
        USER_EMAIL = args[i + 1]
        i += 2
    elif arg == "--description":
        DESCRIPTION = args[i + 1]
        i += 2
    elif arg == "--session-id":
        SESSION_ID = args[i + 1]
        i += 2
    elif arg == "--reset":
        RESET_ID = True
        i += 1
    elif arg == "--index-only":
        INDEX_ONLY = True
        i += 1
    else:
        sys.exit(1)

# -------------------------------
# USER INFO
# -------------------------------
if not USER_NAME:
    USER_NAME = run_git(["config", "user.name"], capture_output=True) or ""

if not USER_EMAIL:
    USER_EMAIL = run_git(["config", "user.email"], capture_output=True) or ""

if not SESSION_ID:
    SESSION_ID = "tracy snapshot"

if not USER_NAME or not USER_EMAIL:
    if DEBUG:
        print(f"Missing user info: NAME='{USER_NAME}', EMAIL='{USER_EMAIL}'", file=sys.stderr)
        print(f"Git config user.name: {run_git(['config', 'user.name'], capture_output=True, cwd=REPO_ROOT)}", file=sys.stderr)
        print(f"Git config user.email: {run_git(['config', 'user.email'], capture_output=True, cwd=REPO_ROOT)}", file=sys.stderr)
        print("Either both --user-name and --user-email are provided, or leave them empty.", file=sys.stderr)
    sys.exit(1)

# -------------------------------
# VISIBLE HEAD
# -------------------------------
if run_git(["rev-parse", "--verify", "HEAD"]):
    VISIBLE_HEAD = run_git(["rev-parse", "HEAD"], capture_output=True)
else:
    VISIBLE_HEAD = "initial"

# -------------------------------
# SKIP IF NO FILE CHANGES
# -------------------------------
if INDEX_ONLY:
    if run_git(["rev-parse", "--verify", "HEAD"]):
        if run_git(["diff", "--cached", "--quiet"]):
            if DEBUG:
                print("No staged changes detected. Skipping Tracy snapshot.", file=sys.stderr)
            sys.exit(0)
    else:
        cached = run_git(["ls-files", "--cached"], capture_output=True)
        if not cached:
            if DEBUG:
                print("No staged changes detected. Skipping Tracy snapshot.", file=sys.stderr)
            sys.exit(0)
else:
    status = run_git(["status", "--porcelain"], capture_output=True)
    if not status:
        if DEBUG:
            print("No repository changes detected. Skipping Tracy snapshot.", file=sys.stderr)
        sys.exit(0)

# -------------------------------
# TRACY ID
# -------------------------------
TRACY_ID = run_git(["config", "--get", "tracy.current-id"], capture_output=True) or ""

if RESET_ID:
    run_git(["config", "--unset", "tracy.current-id"])
    if TRACY_ID:
        run_git(["config", "--unset", f"tracy.{TRACY_ID}.hidden"])

    if DEBUG:
        print("Tracy chain reset.", file=sys.stderr)

    TRACY_ID = ""

if not TRACY_ID:
    TRACY_ID = str(uuid.uuid4()).lower()
    run_git(["config", "tracy.current-id", TRACY_ID])

REF = f"{REF_BASE}/{TRACY_ID}"
# -------------------------------
# TEMPORARY INDEX
# -------------------------------

if INDEX_ONLY:
    TREE = run_git(["write-tree"], capture_output=True)
    if not TREE:
        print("Error: write-tree failed for index", file=sys.stderr)
        sys.exit(1)
else:
    tmp_index = tempfile.NamedTemporaryFile(delete=False)
    tmp_index_path = tmp_index.name
    tmp_index.close()

    real_index = run_git(["rev-parse", "--git-dir"], capture_output=True)
    real_index = os.path.join(real_index, "index")

    if os.path.exists(real_index):
        shutil.copy(real_index, tmp_index_path)

    os.environ["GIT_INDEX_FILE"] = tmp_index_path

    run_git(["add", "-A"])
    TREE = run_git(["write-tree"], capture_output=True)

    os.remove(tmp_index_path)
    os.environ.pop("GIT_INDEX_FILE", None)

    if not TREE:
        print("Error: write-tree failed", file=sys.stderr)
        sys.exit(1)

# -------------------------------
# CHECK FOR PARENT & REDUNDANCY
# -------------------------------

# Use --verify to check if ref exists
if run_git(["rev-parse", "--verify", REF]):
    LATEST_HIDDEN = run_git(["rev-parse", REF], capture_output=True)
else:
    LATEST_HIDDEN = ""

# Prevent creating identical, empty snapshots
if LATEST_HIDDEN:
    latest_tree = run_git(["rev-parse", f"{LATEST_HIDDEN}^{{tree}}"], capture_output=True)
    if TREE == latest_tree:
        if DEBUG:
            print("No changes since last tracy snapshot. Skipping.", file=sys.stderr)
        sys.exit(0)

# -------------------------------
# CREATE COMMIT
# -------------------------------
parent_args = []
if LATEST_HIDDEN:
    parent_args = ["-p", LATEST_HIDDEN]
elif VISIBLE_HEAD != "initial":
    parent_args = ["-p", VISIBLE_HEAD]

env = os.environ.copy()
env.update({
    "GIT_AUTHOR_NAME": USER_NAME,
    "GIT_AUTHOR_EMAIL": USER_EMAIL,
    "GIT_COMMITTER_NAME": USER_NAME,
    "GIT_COMMITTER_EMAIL": USER_EMAIL,
})

commit_cmd = ["git", "commit-tree", TREE] + parent_args + ["-m", SESSION_ID]
if DESCRIPTION:
    commit_cmd += ["-m", DESCRIPTION]

result = subprocess.run(commit_cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)
COMMIT = result.stdout.strip()

if not COMMIT:
    print(f"Error: commit-tree failed: {result.stderr.strip() or 'empty result'}", file=sys.stderr)
    sys.exit(1)

# -------------------------------
# UPDATE REF
# -------------------------------
run_git(["update-ref", REF, COMMIT])

if DEBUG:
    print(f"Committed to {REF} -> {COMMIT}", file=sys.stderr)