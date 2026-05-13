import subprocess
import sys


def run_git(args, capture=False):
    try:
        result = subprocess.run(
            ["git"] + args,
            text=True,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.DEVNULL,
        )
        return result.stdout.strip() if capture else result.returncode == 0
    except Exception:
        return None if capture else False


def main():
    # Only act after the transaction is committed (not prepared/aborted)
    if len(sys.argv) < 2 or sys.argv[1] != "committed":
        return

    # Check if any of the committed ref updates is refs/notes/origin/commits.
    # This fires when git fetch stages remote notes into the tracking ref.
    for line in sys.stdin:
        parts = line.strip().split()
        if len(parts) == 3 and parts[2] == "refs/notes/origin/commits":
            run_git(["notes", "merge", "--strategy=union", "refs/notes/origin/commits"])
            break


if __name__ == "__main__":
    main()
