import subprocess
import sys

PUSH_RULES = [
    "HEAD",
    "refs/tracy/*:refs/tracy/*",
    "refs/notes/commits:refs/notes/commits",
]


def run_git(args, capture=False, check=False):
    try:
        result = subprocess.run(
            ["git"] + args,
            text=True,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.DEVNULL,
            check=check
        )
        return result.stdout.strip() if capture else result.returncode == 0
    except subprocess.CalledProcessError:
        return None if capture else False


def origin_exists():
    return run_git(["remote", "get-url", "origin"], capture=True) is not None


def get_push_rules():
    output = run_git(["config", "--get-all", "remote.origin.push"], capture=True)
    if not output:
        return set()
    return {line.strip() for line in output.splitlines() if line.strip()}


def add_push_rules():
    existing = get_push_rules()
    for rule in PUSH_RULES:
        if rule not in existing:
            run_git(["config", "--add", "remote.origin.push", rule])


def sync_notes_before_push(remote):
    # Fetch the latest remote notes into the staging ref so we don't overwrite
    # concurrent changes made by others since our last fetch.
    run_git(["fetch", remote, "refs/notes/commits:refs/notes/origin/commits"])

    has_staging = run_git(["rev-parse", "--verify", "refs/notes/origin/commits"], capture=True)
    if has_staging:
        run_git(["notes", "merge", "--strategy=union", "refs/notes/origin/commits"])


def main():
    if not origin_exists():
        return

    add_push_rules()

    # sys.argv[1] is the remote name passed by git to the pre-push hook
    remote = sys.argv[1] if len(sys.argv) > 1 else "origin"
    sync_notes_before_push(remote)


if __name__ == "__main__":
    main()
