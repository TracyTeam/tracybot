import subprocess
import tempfile
import sys
import os
import shutil

REF_BASE_LOCAL = "refs/tracy-local"
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


def build_filtered_chain(local_ref, origin_commit, files_in_commit):
    """Build a filtered chain from hidden commits, keeping only files in the user commit."""
    orig_head = run_git(["rev-parse", "ORIG_HEAD"], capture=True)
    
    # Walk only hidden snapshot commits
    log_args = ["log", "--format=%H", local_ref, "--not", "--branches", "--not", "--tags"]
    if orig_head:
        log_args.extend(["--not", orig_head])

    commits = run_git(log_args, capture=True)
    if not commits:
        return ""

    # Reverse order (oldest first)
    commit_list = [commit for commit in commits.splitlines() if commit]
    commit_list.reverse()

    previous_tree = ""
    new_chain_head = ""

    for commit in commit_list:
        # Skip commits with tracy-id notes (user commits)
        note = run_git(["notes", "show", commit], capture=True)
        if note:
            continue

        commit_tree = run_git(["rev-parse", f"{commit}^{{tree}}"], capture=True)
        if not commit_tree:
            continue

        # Get files in this hidden commit
        files_out = run_git(
            ["diff-tree", "--root", "--no-commit-id", "-r", "--name-only", commit],
            capture=True
        )
        if not files_out:
            continue

        commit_files = sorted(set(files_out.splitlines()))

        # Filter to only files that are in the current user commit
        filtered_files = sorted(file for file in commit_files if file in files_in_commit)
        if not filtered_files:
            continue

        # Get commit message
        commit_msg = run_git(["log", "-1", "--format=%s", commit], capture=True) or "tracy snapshot"

        # Get commit description (lines after first)
        full_msg = run_git(["log", "-1", "--format=%B", commit], capture=True) or ""
        msg_lines = full_msg.splitlines()
        commit_desc = ""
        if len(msg_lines) > 1:
            commit_desc = "\n".join(msg_lines[1:])

        # Build temporary index with filtered files
        tmp_index = tempfile.NamedTemporaryFile(delete=False)
        tmp_index_path = tmp_index.name
        tmp_index.close()

        git_dir = run_git(["rev-parse", "--git-dir"], capture=True)
        real_index = os.path.join(git_dir, "index")
        if os.path.exists(real_index):
            shutil.copy(real_index, tmp_index_path)

        env = os.environ.copy()
        env["GIT_INDEX_FILE"] = tmp_index_path

        subprocess.run(["git", "rm", "-rf", "--cached", "."], env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)

        for file in filtered_files:
            ls_out = run_git(["ls-tree", commit_tree, "--", file], capture=True, env=env)
            if not ls_out:
                continue
            parts = ls_out.split()
            if len(parts) >= 3:
                mode = parts[0]
                blob_hash = parts[2]
                subprocess.run(
                    ["git", "update-index", "--add", "--cacheinfo", f"{mode},{blob_hash},{file}"],
                    env=env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    check=False
                )

        tree_result = run_git(["write-tree"], capture=True, env=env)
        os.remove(tmp_index_path)

        if not tree_result or tree_result == previous_tree:
            continue
        previous_tree = tree_result

        # Parent for new commit
        parent_flag = []
        if new_chain_head:
            parent_flag = ["-p", new_chain_head]
        elif origin_commit:
            parent_flag = ["-p", origin_commit]

        author_name = run_git(["log", "-1", "--format=%an", commit], capture=True) or "Tracybot"
        author_email = run_git(["log", "-1", "--format=%ae", commit], capture=True) or "tracybot@local"

        commit_env = os.environ.copy()
        commit_env.update({
            "GIT_AUTHOR_NAME": author_name,
            "GIT_AUTHOR_EMAIL": author_email,
            "GIT_COMMITTER_NAME": author_name,
            "GIT_COMMITTER_EMAIL": author_email,
        })

        cmd = ["git", "commit-tree", tree_result] + parent_flag + ["-m", commit_msg]
        if commit_desc:
            cmd += ["-m", commit_desc]

        result = subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=commit_env)
        new_commit = result.stdout.strip()

        if not new_commit:
            continue

        new_chain_head = new_commit

    return new_chain_head


def main():
    user_commit = run_git(["rev-parse", "HEAD"], capture=True)
    if not user_commit:
        sys.exit(1)

    short_hash = run_git(["rev-parse", "--short=8", "HEAD"], capture=True)
    origin_commit = run_git(["rev-parse", "--verify", "HEAD^"], capture=True) or ""

    tracy_id = run_git(["config", "--get", "tracy.current-id"], capture=True) or ""
    if not tracy_id:
        sys.exit(0)

    ref_local = f"{REF_BASE_LOCAL}/{tracy_id}"
    if not run_git(["rev-parse", "--verify", ref_local], capture=True):
        sys.exit(0)

    # Get files changed in the user commit
    files_in_commit_out = run_git(
        ["diff-tree", "--root", "--no-commit-id", "-r", "--name-only", user_commit],
        capture=True
    )
    if not files_in_commit_out:
        sys.exit(0)

    files_in_commit = set(files_in_commit_out.splitlines())

    final_tracy_id = f"{tracy_id}@{short_hash}" if short_hash else tracy_id
    ref_final = f"{REF_BASE_PUSHED}/{final_tracy_id}"

    final_chain = build_filtered_chain(ref_local, origin_commit, files_in_commit)

    if final_chain:
        run_git(["update-ref", ref_final, final_chain])
        run_git(["config", f"tracy.{final_tracy_id}.hidden", final_chain])

        run_git(["notes", "add", "-f", "-m", f"tracy-id: {final_tracy_id}", user_commit])

        # Clean up local ref if working tree is clean
        if run_git(["diff", "--quiet"]):
            run_git(["update-ref", "-d", ref_local])
            run_git(["config", "--unset", "tracy.current-id"])


if __name__ == "__main__":
    main()
