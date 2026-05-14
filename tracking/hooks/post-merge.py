import subprocess
import sys

def run_git(args, capture=False):
    try:
        result = subprocess.run(
            ["git"] + args,
            text=True,
            stdout=subprocess.PIPE if capture else None,
            stderr=sys.stderr,
        )
        return result.stdout.strip() if capture else result.returncode == 0
    except Exception:
        return None if capture else False


def main():
    has_staging = run_git(["rev-parse", "--verify", "refs/notes/origin/commits"], capture=True)
    if has_staging:
        run_git(["notes", "merge", "--strategy=union", "refs/notes/origin/commits"])


if __name__ == "__main__":
    main()
