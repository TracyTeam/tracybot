import subprocess
import sys
import os
import re
import uuid

REF_BASE_PUSHED = "refs/tracy"


def run_git(args, capture=False, check=False, env=None):
    try:
        result = subprocess.run(
            ["git"] + args,
            text=True,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.DEVNULL,
            check=check,
            env=env
        )
        return result.stdout.strip() if capture else result.returncode == 0
    except subprocess.CalledProcessError:
        return None if capture else False


def get_tracy_ids_from_note(note):
    """Extract tracy-id values from a git note."""
    if not note:
        return []
    return re.findall(r'tracy-id:\s*([a-f0-9@-]+)', note)


def get_chain_commits_oldest_first(tracy_id):
    """Get commits in a tracy chain, oldest first."""
    ref = f"{REF_BASE_PUSHED}/{tracy_id}"

    if not run_git(["rev-parse", "--verify", ref], capture=True):
        return []

    # Determine exclusion ref for tracy_ids with commit hash (uuid@hash)
    exclude_ref = ""
    if "@" in tracy_id:
        short_hash = tracy_id.split("@")[1]
        exclude_ref = run_git(["rev-parse", "--verify", f"{short_hash}^"], capture=True)

    # Get commits in the chain
    log_args = ["log", "--format=%H", ref, "--not", "--branches", "--not", "--tags"]
    if exclude_ref:
        log_args = ["log", "--format=%H", ref, "--not", exclude_ref]

    commits = run_git(log_args, capture=True)
    if not commits:
        return []

    # Reverse to get oldest first
    commit_list = [c for c in commits.splitlines() if c]
    commit_list.reverse()
    return commit_list


def delete_chain(tracy_id):
    """Delete a tracy chain and its config."""
    run_git(["update-ref", "-d", f"{REF_BASE_PUSHED}/{tracy_id}"])
    run_git(["config", "--unset", f"tracy.{tracy_id}.hidden"])


def collect_commits_for_ids(tracy_ids):
    """Collect all commits from multiple tracy IDs."""
    all_commits = []
    for tid in tracy_ids:
        if not tid:
            continue
        commits = get_chain_commits_oldest_first(tid)
        all_commits.extend(commits)
    return all_commits


def build_chain_from_commits(commits_list, origin_commit):
    """Build a new chain from a list of commits, preserving metadata."""
    if not commits_list:
        return ""

    # Deduplicate while preserving order
    seen = set()
    deduped = []
    for c in commits_list:
        if c and c not in seen:
            seen.add(c)
            deduped.append(c)

    parent = origin_commit
    new_tip = ""

    for commit in deduped:
        commit_tree = run_git(["rev-parse", f"{commit}^{{tree}}"], capture=True)
        if not commit_tree:
            continue

        # Get full message
        msg = run_git(["log", "-1", "--format=%B", commit], capture=True) or "tracy snapshot"

        # Get metadata
        meta_str = run_git(
            ["log", "-1", "--format=%an%n%ae%n%aI%n%cn%n%ce%n%cI", commit],
            capture=True
        )
        if not meta_str:
            continue

        meta_lines = (meta_str or "").splitlines()

        author_name = meta_lines[0] if len(meta_lines) > 0 else "Tracybot"
        author_email = meta_lines[1] if len(meta_lines) > 1 else "tracybot@local"
        author_date = meta_lines[2] if len(meta_lines) > 2 else ""
        committer_name = meta_lines[3] if len(meta_lines) > 3 else author_name
        committer_email = meta_lines[4] if len(meta_lines) > 4 else author_email
        committer_date = meta_lines[5] if len(meta_lines) > 5 else ""

        # Build commit-tree command
        env = os.environ.copy()
        env["GIT_AUTHOR_NAME"] = author_name
        env["GIT_AUTHOR_EMAIL"] = author_email
        env["GIT_COMMITTER_NAME"] = committer_name
        env["GIT_COMMITTER_EMAIL"] = committer_email

        if author_date and committer_date:
            env["GIT_AUTHOR_DATE"] = author_date
            env["GIT_COMMITTER_DATE"] = committer_date
        else:
            env.pop("GIT_AUTHOR_DATE", None)
            env.pop("GIT_COMMITTER_DATE", None)

        cmd = ["git", "commit-tree", commit_tree]
        if parent:
            cmd.extend(["-p", parent])
        cmd.extend(["-m", msg])

        result = subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)
        new_commit = (result.stdout or "").strip()
        
        if new_commit:
            parent = new_commit
            new_tip = new_commit

    return new_tip


def publish_chain(all_commits, target_sha):
    """Create a refs/tracy chain and attach it to a commit's note."""
    if not all_commits:
        return

    new_uuid = str(uuid.uuid4()).lower()
    short_hash = run_git(["rev-parse", "--short=8", target_sha], capture=True)

    final_id = new_uuid
    if short_hash:
        final_id = f"{new_uuid}@{short_hash}"

    new_origin = run_git(["rev-parse", "--verify", f"{target_sha}^"], capture=True)
    new_tip = build_chain_from_commits(all_commits, new_origin)

    if new_tip:
        run_git(["update-ref", f"{REF_BASE_PUSHED}/{final_id}", new_tip])
        run_git(["config", f"tracy.{final_id}.hidden", new_tip])
        run_git(["notes", "add", "-f", "-m", f"tracy-id: {final_id}", target_sha])


def handle_amend(old_sha, new_sha):
    """Handle amend: prepend old chain to new chain."""
    old_note = run_git(["notes", "show", old_sha], capture=True) or ""
    new_note = run_git(["notes", "show", new_sha], capture=True) or ""

    old_ids = get_tracy_ids_from_note(old_note)
    new_ids = get_tracy_ids_from_note(new_note)

    old_commits = collect_commits_for_ids(old_ids)
    new_commits = collect_commits_for_ids(new_ids)

    all_commits = old_commits + new_commits
    publish_chain(all_commits, new_sha)


def handle_rebase(old_sha, new_sha):
    """Handle rebase: publish old chain under fresh ID for new SHA."""
    old_note = run_git(["notes", "show", old_sha], capture=True) or ""
    old_ids = get_tracy_ids_from_note(old_note)

    if not old_ids:
        return

    all_commits = collect_commits_for_ids(old_ids)
    publish_chain(all_commits, new_sha)


def handle_squash(new_sha, old_shas_str):
    """Handle squash: merge chains from all old SHAs."""
    all_commits = []

    # Sort old shas by author timestamp (oldest first)
    old_shas_with_ts = []
    for old_sha in old_shas_str.splitlines():
        if not old_sha:
            continue
        ts = run_git(["log", "-1", "--format=%at", old_sha], capture=True) or "0"
        old_shas_with_ts.append((int(ts), old_sha))

    old_shas_with_ts.sort(key=lambda x: x[0])
    sorted_old_shas = [sha for _, sha in old_shas_with_ts]

    for old_sha in sorted_old_shas:
        old_note = run_git(["notes", "show", old_sha], capture=True) or ""
        old_ids = get_tracy_ids_from_note(old_note)
        old_commits = collect_commits_for_ids(old_ids)
        all_commits.extend(old_commits)

    publish_chain(all_commits, new_sha)


def main():
    rewrite_type = sys.argv[1] if len(sys.argv) > 1 else "rebase"

    # Read all pairs from stdin
    all_pairs = []
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) == 2:
            all_pairs.append((parts[0], parts[1]))

    # Collect unique new_shas in insertion order
    new_shas_ordered = []
    for old_sha, new_sha in all_pairs:
        if new_sha not in new_shas_ordered:
            new_shas_ordered.append(new_sha)

    for new_sha in new_shas_ordered:
        # Collect all old shas for this new_sha
        old_shas_str = "\n".join([old for old, n in all_pairs if n == new_sha])

        old_count = len([old for old, n in all_pairs if n == new_sha])

        if old_count > 1:
            handle_squash(new_sha, old_shas_str)
        elif rewrite_type == "amend":
            handle_amend(old_shas_str.strip(), new_sha)
        else:
            handle_rebase(old_shas_str.strip(), new_sha)


if __name__ == "__main__":
    main()
