from hook_utils import run_git
import sys


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
