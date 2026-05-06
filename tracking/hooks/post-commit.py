#!/usr/bin/env python3
import subprocess
import sys


def run_git(args, capture=False):
    try:
        result = subprocess.run(
            ["git"] + args,
            text=True,
            capture_output=capture,
            check=True
        )
        return result.stdout.strip() if capture else True
    except subprocess.CalledProcessError:
        return None if capture else False


def main():
    # -------------------------------
    # GET LAST COMMIT
    # -------------------------------
    user_commit = run_git(["rev-parse", "HEAD"], capture=True)
    if not user_commit:
        sys.exit(1)

    # -------------------------------
    # GET TRACY ID
    # -------------------------------
    tracy_id = run_git(["config", "--get", "tracy.current-id"], capture=True) or ""

    if tracy_id:
        # Attach note to commit
        run_git([
            "notes", "add", "-f",
            "-m", f"tracy-id: {tracy_id}",
            user_commit
        ])

        # -------------------------------
        # CLEAR CHAIN IF CLEAN
        # -------------------------------
        # git diff --quiet returns 0 if no unstaged changes
        clean = subprocess.run(
            ["git", "diff", "--quiet"]
        ).returncode == 0

        if clean:
            run_git(["config", "--unset", "tracy.current-id"])


if __name__ == "__main__":
    main()