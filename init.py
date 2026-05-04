import sys
import re
import subprocess
import shutil
from pathlib import Path

# Colors
G = "\033[32m"
R = "\033[31m"
Y = "\033[33m"
B = "\033[34m"
NC = "\033[0m"
BOLD = "\033[1m"


def run_git(repo, args, capture=False, check=False):
    try:
        result = subprocess.run(
            ["git", "-C", repo] + args,
            text=True,
            capture_output=capture,
            check=check
        )
        return result.stdout.strip() if capture else result.returncode == 0
    except subprocess.CalledProcessError:
        return None if capture else False


def find_repo(start: Path):
    current = start.resolve()
    while current != current.parent:
        if (current / ".git").exists():
            return current
        current = current.parent
    return None


def confirm():
    print("  Confirm initialization? (y/n) ", end="", flush=True)
    ch = sys.stdin.read(1)
    print()
    return ch.lower() == "y"


def add_config_if_missing(repo, key, value):
    existing = run_git(repo, ["config", "--get-all", key], capture=True) or ""
    if value in existing.splitlines():
        return
    run_git(repo, ["config", "--add", key, value])


def main():
    args = sys.argv[1:]

    # -------------------------------
    # REPO RESOLUTION
    # -------------------------------
    if not args:
        repo = find_repo(Path.cwd())
        if not repo:
            print(f"\n{R}******************************************************{NC}")
            print(f"{R}* ERROR: No git repository found                     *{NC}")
            print(f"{R}******************************************************{NC}\n")
            sys.exit(1)

        print(f"\n{B}+-----------------------+{NC}")
        print(f"{B}| INITIALIZING TRACYBOT |{NC}")
        print(f"{B}+-----------------------+{NC}\n")
        print(f"  {BOLD}Target Path:{NC} {repo}\n")

        if not confirm():
            print(f"{Y}Initialization aborted.{NC}")
            sys.exit(0)

    else:
        repo = find_repo(Path(args[0]))
        if not repo:
            print(f"\n{R}******************************************************{NC}")
            print(f"{R}* ERROR: Tracybot requires a git repository          *{NC}")
            print(f"{R}******************************************************{NC}\n")
            sys.exit(1)

    repo = str(repo)

    # -------------------------------
    # CHECK ORIGIN
    # -------------------------------
    if not run_git(repo, ["remote", "get-url", "origin"], capture=True):
        print(f"\n{R}******************************************************{NC}")
        print(f"{R}* ERROR: Tracybot requires an 'origin' remote        *{NC}")
        print(f"{R}******************************************************{NC}\n")
        sys.exit(1)

    git_dir = Path(repo) / ".git"
    tracy_dir = git_dir / "tracybot"

    script_source = Path(__file__).resolve().parent / "tracking" / "tracy.py"

    tracy_dir.mkdir(parents=True, exist_ok=True)

    # -------------------------------
    # GIT CONFIG
    # -------------------------------
    run_git(repo, ["config", "notes.rewrite.rebase", "true"])
    run_git(repo, ["config", "notes.rewrite.merge", "true"])
    run_git(repo, ["config", "notes.rewriteRef", "refs/notes/commits"])

    add_config_if_missing(repo, "remote.origin.push", "HEAD")
    add_config_if_missing(repo, "remote.origin.push", "refs/tracy/*:refs/tracy/*")
    add_config_if_missing(repo, "remote.origin.push", "refs/notes/*:refs/notes/*")

    add_config_if_missing(repo, "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")
    add_config_if_missing(repo, "remote.origin.fetch", "+refs/tracy/*:refs/tracy/*")
    add_config_if_missing(repo, "remote.origin.fetch", "+refs/notes/*:refs/notes/*")

    print("+----------------------------------------------------+")
    print("| [DONE] Git notes rewriting configured              |")
    print("| [DONE] Tracy refs configured for fetch and push    |")
    print("+----------------------------------------------------+\n")

    # -------------------------------
    # FETCH
    # -------------------------------
    print(f"{BOLD}Syncing with remote...{NC}\n")

    ok = True
    for cmd in [
        ["fetch", "origin"],
        ["fetch", "origin", "+refs/tracy/*:refs/tracy/*"],
        ["fetch", "origin", "+refs/notes/commits:refs/notes/commits"],
    ]:
        if not run_git(repo, cmd):
            ok = False

    if not ok:
        print("  [INFO] No remote tracing data found")
    else:
        print(f"  {G}[OK] Successfully fetched latest tracing data{NC}")

    print()

    # -------------------------------
    # CONFIG FILE
    # -------------------------------
    with open(tracy_dir / "config", "w") as f:
        f.write(f"TRACY_SNAPSHOT_SCRIPT={script_source.as_posix()}\n")

    # -------------------------------
    # HOOKS
    # -------------------------------
    hooks_source = Path(__file__).resolve().parent / "tracking" / "hooks"
    hooks_dir = git_dir / "hooks"
    hooks_dir.mkdir(exist_ok=True)

    print(f"{BOLD}Installing Git Hooks:{NC}\n")

    rows = []

    for hook in ["pre-commit", "post-commit", "post-rewrite"]:
        source_hook = hooks_source / f"{hook}.py"
        tracy_hook = hooks_dir / f"{hook}.tracy"
        dest_hook = hooks_dir / hook

        start_marker = "# --- TRACYBOT START ---"
        end_marker = "# --- TRACYBOT END ---"

        tracy_block = f"""{start_marker}
#
# !!! WARNING: DO NOT MODIFY OR REMOVE THIS BLOCK !!!
#
# This section is managed automatically by Tracybot.
# Any manual changes inside these markers may be overwritten.
# You may safely edit anything outside this block

TRACY_FILE="$(git rev-parse --git-path hooks)/{hook}.tracy"

if [ -e "$TRACY_FILE" ]; then
    if command -v python3 >/dev/null 2>&1 && python3 -c "import sys" >/dev/null 2>&1; then
        PYTHON_CMD="python3"
    elif command -v python >/dev/null 2>&1 && python -c "import sys" >/dev/null 2>&1; then
        PYTHON_CMD="python"
    else
        echo "Error: Python is not installed or not working." >&2
        exit 1
    fi

    "$PYTHON_CMD" "$TRACY_FILE" "$@"
fi
{end_marker}
"""

        if dest_hook.exists():
            content = dest_hook.read_text()

            if start_marker in content and end_marker in content:
                start_idx = content.find(start_marker)
                end_idx = content.find(end_marker)

                if start_idx != -1 and end_idx != -1:
                    end_idx += len(end_marker)
                    new_content = content[:start_idx] + tracy_block + content[end_idx:]
                else:
                    new_content = content + "\n" + tracy_block

                dest_hook.write_text(new_content)
                dest_hook.chmod(0o755)
                status = f"{G}Updated{NC}"
            else:
                print(f"{Y}WARNING: {hook} hook already exists.{NC}")
                print("Tracybot will preserve its current functionality.")
                print(f"A backup will be saved as {B}{hook}.backup{NC}\n")

                shutil.copy(dest_hook, dest_hook.with_suffix(".backup"))

                lines = content.splitlines(keepends=True)
                if lines and lines[0].startswith("#!"):
                    new_content = lines[0] + tracy_block + "".join(lines[1:])
                else:
                    new_content = tracy_block + content

                dest_hook.write_text(new_content)
                dest_hook.chmod(0o755)

                status = f"{Y}Backed up & Updated{NC}"
        else:
            dest_hook.write_text("#!/usr/bin/env bash\n" + tracy_block)
            dest_hook.chmod(0o755)
            status = f"{G}Installed{NC}"

        shutil.copy(source_hook, tracy_hook)
        tracy_hook.chmod(0o755)

        status_clean = re.sub(r'\033\[[0-9;]*m', '', status)
        rows.append(f"| {hook:<16} | {status}{' ' * (31 - len(status_clean))} |")

    print("+------------------+---------------------------------+")
    print(f"| {'Hook':<16} | {'Status':<31} |")
    print("+------------------+---------------------------------+")
    for row in rows:
        print(row)
    print("+------------------+---------------------------------+\n")

    print(f"{G}******************************************************{NC}")
    print(f"{G}* SUCCESS: Tracybot is ready to go!                  *{NC}")
    print(f"{G}******************************************************{NC}\n")

    print(f"{Y}Note:{NC} If the {B}origin{NC} remote is changed or replaced,")
    print("you must re-run this initialization script, or manually reconfigure:\n")

    print('  git config --add remote.origin.push "HEAD"')
    print('  git config --add remote.origin.push "refs/tracy/*:refs/tracy/*"')
    print('  git config --add remote.origin.push "refs/notes/*:refs/notes/*"')
    print('  git config --add remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"')
    print('  git config --add remote.origin.fetch "+refs/tracy/*:refs/tracy/*"')
    print('  git config --add remote.origin.fetch "+refs/notes/*:refs/notes/*"')


if __name__ == "__main__":
    main()