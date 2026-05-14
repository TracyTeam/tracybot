from hook_utils import run_git
import sys


def main():
    has_staging = run_git(["rev-parse", "--verify", "refs/notes/origin/commits"], capture=True)
    if has_staging:
        run_git(["notes", "merge", "--strategy=union", "refs/notes/origin/commits"])


if __name__ == "__main__":
    main()
