#!/usr/bin/env bash

set -euo pipefail

repo_path=""

if [[ $# -eq 0 ]]; then # No args
    current_dir="$(pwd)"
    
	# Traverse up until a git repository is found
    while [[ "$current_dir" != "/" ]]; do
        if [[ -d "$current_dir/.git" ]]; then
            repo_path="$current_dir"
            break
        fi

        current_dir="$(dirname "$current_dir")"
    done

    if [[ -z "$repo_path" ]] || [[ ! -d "$repo_path/.git" ]]; then
        echo "Error: No git repository found" >&2
        exit 1
    fi

    echo "Found git repository at: $repo_path"
	
    read -p "Are you sure you want to initialize tracybot at $repo_path? (y/n) " -n 1 -r
    echo

    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi
else
    repo_path="$(cd "$1" && pwd)"
	
    while [[ "$repo_path" != "/" ]] && [[ ! -d "$repo_path/.git" ]]; do
        repo_path="$(dirname "$repo_path")"
    done

    if [[ ! -d "$repo_path/.git" ]]; then
        echo "Error: Tracy can only exist in a git repository" >&2
        exit 1
    fi
fi

git_dir="$repo_path/.git"
tracy_dir="$git_dir/tracybot"

# Determine the absolute path to the tracy.sh script
script_source="$(dirname "${BASH_SOURCE[0]}")/tracking/tracy.sh"

mkdir -p "$tracy_dir"

git -C "$repo_path" config notes.rewrite.rebase true
git -C "$repo_path" config notes.rewrite.merge true
git -C "$repo_path" config notes.rewriteRef refs/notes/commits

echo "Configured git notes rewriting"

# Write the config file
cat > "$tracy_dir/config" << EOF
TRACY_SCRIPT=$script_source
EOF

hooks_source="$(dirname "${BASH_SOURCE[0]}")/tracking/hooks"
hooks_dir="$git_dir/hooks"
mkdir -p "$hooks_dir"

# Install hooks
for hook in pre-commit post-commit post-rewrite; do
    source_hook="$hooks_source/$hook"
    dest_hook="$hooks_dir/$hook"

    if [[ -f "$dest_hook" ]]; then
		echo ""
        echo "Warning: $hook hook already exists"
        echo "This will override your existing $hook hook"
		echo "A backup ($hook.backup) will be created"
		echo ""
        read -p "Continue? (y/n) " -n 1 -r
        echo
        
		if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "Aborted."
        	exit 0
        fi
        
        mv "$dest_hook" "${dest_hook}.backup"
        echo "Backed up existing hook to ${dest_hook}.backup"
    fi

    cp "$source_hook" "$dest_hook"
    chmod +x "$dest_hook"
done

echo "Tracybot initialized successfully at $repo_path"
