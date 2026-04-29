#!/usr/bin/env bash
set -euo pipefail

# Base Git reference namespace for snapshots
REF_BASE="refs/tracy-local"
USER_NAME=""
USER_EMAIL=""
DESCRIPTION=""        # Optional description (prompt) for snapshot
SESSION_ID=""
RESET_ID=false        # Flag to reset identifier
INDEX_ONLY=false      # Flag to snapshot the index instead of the working tree
DEBUG=true

while [[ $# -gt 0 ]]; do
    case "$1" in
        --user-name)
            USER_NAME="$2"
            shift 2
            ;;
        --user-email)
            USER_EMAIL="$2"
            shift 2
            ;;
        --description)
            DESCRIPTION="$2"
            shift 2
            ;;
        --session-id)
            SESSION_ID="$2"
            shift 2
            ;;
        --reset)
            RESET_ID=true
            shift
            ;;
        --index-only)
            INDEX_ONLY=true
            shift
            ;;
        *)
            echo "Unknown argument: $1"
            exit 1
            ;;
    esac
done

# -------------------------------
# USER INFO
# -------------------------------

USER_NAME=${USER_NAME:-$(git config user.name || true)}
USER_EMAIL=${USER_EMAIL:-$(git config user.email || true)}
SESSION_ID=${SESSION_ID:-"tracy snapshot"}

if [[ -z "$USER_NAME" || -z "$USER_EMAIL" ]]; then  # Ensure both values exist
    if $DEBUG; then
        echo "Either both --user-name and --user-email are provided, or leave them empty."
    fi

    exit 1
fi

# -------------------------------
# VISIBLE HEAD
# -------------------------------

if git rev-parse --verify HEAD >/dev/null 2>&1; then # Check if repo has commits
    VISIBLE_HEAD=$(git rev-parse HEAD)               # Get current commit hash
else
    VISIBLE_HEAD="initial"                           # Mark as initial state if no commits exist
fi

# -------------------------------
# SKIP IF NO FILE CHANGES
# -------------------------------
if $INDEX_ONLY; then
    # If index-only, we only care about staged changes
    if git rev-parse --verify HEAD >/dev/null 2>&1; then
        if git diff --cached --quiet; then
            if $DEBUG; then echo "No staged changes detected. Skipping Tracy snapshot."; fi
            exit 0
        fi
    else
        # Fresh repo with no commits yet
        if [[ -z "$(git ls-files --cached)" ]]; then
            if $DEBUG; then echo "No staged changes detected. Skipping Tracy snapshot."; fi
            exit 0
        fi
    fi
else
    # Check for all changes: staged, unstaged, AND untracked
    if [[ -z "$(git status --porcelain)" ]]; then
        if $DEBUG; then echo "No repository changes detected. Skipping Tracy snapshot."; fi
        exit 0
    fi
fi

# -------------------------------
# TRACY ID
# -------------------------------

TRACY_ID=$(git config --get tracy.current-id || true)  # Try to get existing Tracy ID

if $RESET_ID; then
    # Remove stored Tracy ID
    git config --unset tracy.current-id 2>/dev/null || true 
    # Remove mapping to hidden commit
    if [[ -n "$TRACY_ID" ]]; then
        git config --unset tracy."$TRACY_ID".hidden 2>/dev/null || true
    fi

    if $DEBUG; then
        echo "Tracy chain reset."
    fi

    TRACY_ID=""
fi

if [[ -z "$TRACY_ID" ]]; then
    TRACY_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')   # Generate new UUID if missing
    git config tracy.current-id "$TRACY_ID"            # Store it in git config
fi
REF="$REF_BASE/$TRACY_ID"

# -------------------------------
# TEMPORARY INDEX FOR HIDDEN COMMIT
# -------------------------------

if $INDEX_ONLY; then
    TREE=$(git write-tree) # Snapshot the actual staged changes
else
    TMP_INDEX=$(mktemp)                            # Create temporary file for Git index
    REAL_INDEX="$(git rev-parse --git-dir)/index"  # Path to real Git index

    # Only copy index if it actually exists (prevents crash on fresh repos)
    if [[ -f "$REAL_INDEX" ]]; then
        cp "$REAL_INDEX" "$TMP_INDEX"   # Copy current index to temp index
    fi

    export GIT_INDEX_FILE="$TMP_INDEX"  # Tell Git to use temp index instead of real one
    git add -A                          # Stage everything into the temporary index
    TREE=$(git write-tree)              # Create a tree object from current index state
    
    rm -f "$TMP_INDEX"                  # Delete temporary index file
fi

# -------------------------------
# CHECK FOR PARENT & REDUNDANCY
# -------------------------------

if git rev-parse --verify "$REF" >/dev/null 2>&1; then
    LATEST_HIDDEN=$(git rev-parse "$REF")
else
    LATEST_HIDDEN=""
fi

# Prevent creating identical, empty snapshots
if [[ -n "$LATEST_HIDDEN" ]]; then
    # Get tree of last hidden commit
    LATEST_TREE=$(git rev-parse "$LATEST_HIDDEN^{tree}" 2>/dev/null || true)
    if [[ "$TREE" == "$LATEST_TREE" ]]; then
        if $DEBUG; then
            echo "No changes since last tracy snapshot. Skipping."
        fi

        exit 0
    fi
fi

# Determine parent flag
if [[ -n "$LATEST_HIDDEN" ]]; then
    PARENT_FLAG="-p $LATEST_HIDDEN"  # Use previous hidden commit as parent
elif [[ "$VISIBLE_HEAD" != "initial" ]]; then
    PARENT_FLAG="-p $VISIBLE_HEAD"   # Otherwise use current HEAD as parent
else
    PARENT_FLAG=""                   # No parent for first commit
fi

# -------------------------------
# HIDDEN COMMIT
# -------------------------------


COMMIT=$(GIT_AUTHOR_NAME="$USER_NAME" GIT_AUTHOR_EMAIL="$USER_EMAIL" \
        GIT_COMMITTER_NAME="$USER_NAME" GIT_COMMITTER_EMAIL="$USER_EMAIL" \
        git commit-tree "$TREE" $PARENT_FLAG -m "$SESSION_ID" ${DESCRIPTION:+-m "$DESCRIPTION"})

# -------------------------------
# UPDATE HIDDEN BRANCH REF
# -------------------------------

git update-ref "$REF" "$COMMIT"  # Move/update Tracy ref to new commit

if $DEBUG; then
    echo "Committed to $REF -> $COMMIT"
fi
