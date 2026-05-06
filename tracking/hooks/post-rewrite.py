#!/usr/bin/env python3
import subprocess
import sys
import os


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


# -------------------------------
# COPY HIDDEN CONFIG
# -------------------------------
def update_tracy_hidden(old_sha, new_sha):
    old_hidden = run_git(["config", "--get", f"tracy.{old_sha}.hidden"], capture=True) or ""
    if old_hidden:
        run_git(["config", f"tracy.{new_sha}.hidden", old_hidden])


# -------------------------------
# COMBINE CHAINS
# -------------------------------
def combine_tracy_chains(chain_hiddens):
    if len(chain_hiddens) < 2:
        return chain_hiddens[0] if chain_hiddens else ""

    newer_head = chain_hiddens[0]
    older_head = chain_hiddens[1]

    merge_base = run_git(["merge-base", newer_head, older_head], capture=True)

    older_commits = []
    log_output = run_git(["log", "--format=%h", older_head], capture=True) or ""

    for commit in log_output.splitlines():
        if merge_base and commit == merge_base:
            break
        older_commits.append(commit)

    if not older_commits:
        return newer_head

    current_head = newer_head

    # Prepend older commits in reverse order
    for commit_hash in reversed(older_commits):
        commit_tree = run_git(["rev-parse", f"{commit_hash}^{{tree}}"], capture=True)
        if not commit_tree:
            continue

        env = os.environ.copy()
        env.update({
            "GIT_AUTHOR_NAME": "Tracybot",
            "GIT_AUTHOR_EMAIL": "Tracybot@local"
        })

        try:
            result = subprocess.run(
                ["git", "commit-tree", "-p", current_head, commit_tree, "-m", "Merged tracy chain"],
                text=True,
                capture_output=True,
                env=env,
                check=True
            )
            new_commit = result.stdout.strip()
            if new_commit:
                current_head = new_commit
        except subprocess.CalledProcessError:
            break

    return current_head


# -------------------------------
# MERGE MULTIPLE TRACY IDS
# -------------------------------
def update_tracy_hidden_from_refs(tracy_ids, new_sha):
    first_hidden = ""
    chain_hiddens = []

    for tracy_id in tracy_ids:
        if not tracy_id:
            continue

        ref = f"refs/tracy/{tracy_id}"
        exists = run_git(["rev-parse", "--verify", ref])
        if not exists:
            continue

        hidden = run_git(["rev-parse", f"{ref}^{{commit}}"], capture=True)
        if hidden:
            if not first_hidden:
                first_hidden = hidden
            chain_hiddens.append(hidden)

    if len(chain_hiddens) > 1:
        combined = combine_tracy_chains(chain_hiddens)
        if combined:
            run_git(["config", f"tracy.{new_sha}.hidden", combined])
    elif first_hidden:
        run_git(["config", f"tracy.{new_sha}.hidden", first_hidden])


# -------------------------------
# MAIN LOOP (stdin pairs)
# -------------------------------
def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        parts = line.split()
        if len(parts) != 2:
            continue

        old_sha, new_sha = parts

        old_note = run_git(["notes", "show", old_sha], capture=True) or ""
        new_note = run_git(["notes", "show", new_sha], capture=True) or ""

        # Neither has note
        if not old_note and not new_note:
            continue

        # Only old has note
        if old_note and not new_note:
            subprocess.run(
                ["git", "notes", "add", "-f", "-F", "-", new_sha],
                input=old_note,
                text=True
            )
            update_tracy_hidden(old_sha, new_sha)
            continue

        # Only new has note
        if not old_note and new_note:
            continue

        # Both have notes → merge
        merged_note = new_note + "\n" + old_note
        subprocess.run(
            ["git", "notes", "add", "-f", "-F", "-", new_sha],
            input=merged_note,
            text=True
        )

        # Extract tracy IDs
        import re
        old_ids = re.findall(r"tracy-id: ([a-f0-9-]+)", old_note)
        new_ids = re.findall(r"tracy-id: ([a-f0-9-]+)", new_note)

        all_ids = new_ids + old_ids

        update_tracy_hidden_from_refs(all_ids, new_sha)


if __name__ == "__main__":
    main()