import subprocess
import os
from pathlib import Path
import sys

LOCK_FILE = ".git/tracybot/fetch-repair.lock"

TRACY_FETCH_RULES = [
    "+refs/heads/*:refs/remotes/origin/*",
    "+refs/tracy/*:refs/tracy/*",
    "+refs/notes/*:refs/notes/origin/*",
]


def run_git(args, capture=False, check=False):
    try:
        result = subprocess.run(
            ["git"] + args,
            text=True,
            stdout=subprocess.PIPE if capture else None,
            stderr=sys.stderr,
            check=check
        )
        return result.stdout.strip() if capture else result.returncode == 0
    except subprocess.CalledProcessError:
        return None if capture else False


def is_locked():
    lock_path = Path(os.getcwd()) / LOCK_FILE
    return lock_path.exists()


def create_lock():
    lock_path = Path(os.getcwd()) / LOCK_FILE
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path.touch()


def remove_lock():
    lock_path = Path(os.getcwd()) / LOCK_FILE
    if lock_path.exists():
        lock_path.unlink()


def origin_exists():
    result = run_git(["remote", "get-url", "origin"], capture=True)
    return result is not None


def get_fetch_rules():
    output = run_git(
        ["config", "--get-all", "remote.origin.fetch"],
        capture=True
    ) or ""
    return {line.strip() for line in output.splitlines() if line.strip()}


def add_missing_fetch_rules(current_rules):
    missing = [r for r in TRACY_FETCH_RULES if r not in current_rules]

    for rule in missing:
        run_git(["config", "--add", "remote.origin.fetch", rule])

    return len(missing) > 0


def re_fetch():
    for refspec in TRACY_FETCH_RULES:
        run_git(["fetch", "origin", refspec])


def merge_remote_notes():
    has_staging = run_git(["rev-parse", "--verify", "refs/notes/origin/commits"], capture=True)
    if has_staging:
        run_git(["notes", "merge", "--strategy=union", "refs/notes/origin/commits"])


def main():
    if is_locked():
        remove_lock()
        return

    if not origin_exists():
        return

    current_rules = get_fetch_rules()
    changed = add_missing_fetch_rules(current_rules)

    if changed:
        create_lock()
        re_fetch()

    merge_remote_notes()


if __name__ == "__main__":
    main()
