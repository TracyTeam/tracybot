#!/usr/bin/env bash
set -euo pipefail

G="\033[32m"
R="\033[31m"
Y="\033[33m"
B="\033[34m"

NC="\033[0m"

BOLD="\033[1m"

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
        printf "\n${R}******************************************************${NC}\n"
        printf "${R}* ERROR: No git repository found                     *${NC}\n"
        printf "${R}******************************************************${NC}\n\n"
        exit 1
    fi

    printf "\n${B}+------------------------+${NC}\n"
    printf "${B}| INITIALIZING TRACYBOT |${NC}\n"
    printf "${B}+-----------------------+${NC}\n"
    printf "  ${BOLD}Target Path:${NC} %s\n\n" "$repo_path"
    
    printf "  Confirm initialization? (y/n) "
    read -n 1 -r
    printf "\n\n"

    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        printf "${Y}Initialization aborted.${NC}\n"
        exit 0
    fi
else
    repo_path="$(cd "$1" && pwd)"
	
    while [[ "$repo_path" != "/" ]] && [[ ! -d "$repo_path/.git" ]]; do
        repo_path="$(dirname "$repo_path")"
    done

    if [[ ! -d "$repo_path/.git" ]]; then
        printf "\n${R}******************************************************${NC}\n"
        printf "${R}* ERROR: Tracybot requires a git repository          *${NC}\n"
        printf "${R}******************************************************${NC}\n\n"
        exit 1
    fi
fi

if ! git -C "$repo_path" remote get-url origin >/dev/null 2>&1; then
    printf "\n${R}******************************************************${NC}\n"
    printf "${R}* ERROR: Tracybot requires an 'origin' remote        *${NC}\n"
    printf "${R}******************************************************${NC}\n\n"
    exit 1
fi

git_dir="$repo_path/.git"
tracy_dir="$git_dir/tracybot"

# Determine the absolute path to the tracy.sh script
script_source="$(dirname "${BASH_SOURCE[0]}")/tracking/tracy.sh"

mkdir -p "$tracy_dir"

git -C "$repo_path" config notes.rewrite.rebase true
git -C "$repo_path" config notes.rewrite.merge true
git -C "$repo_path" config notes.rewriteRef refs/notes/commits

add_config_if_missing() {
  local key="$1"
  local value="$2"

  git -C "$repo_path" config --get-all "$key" | grep -Fxq "$value" && return 0
  git -C "$repo_path" config --add "$key" "$value"
}

add_config_if_missing remote.origin.push "HEAD"
add_config_if_missing remote.origin.push "refs/tracy/*:refs/tracy/*"
add_config_if_missing remote.origin.push "refs/notes/commits:refs/notes/commits"

add_config_if_missing remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"
add_config_if_missing remote.origin.fetch "+refs/tracy/*:refs/tracy/*"
add_config_if_missing remote.origin.fetch "+refs/notes/commits:refs/notes/commits"

printf "+----------------------------------------------------+\n"
printf "| [DONE] Git notes rewriting configured              |\n"
printf "| [DONE] Tracy refs configured for fetch and push    |\n"
printf "+----------------------------------------------------+\n\n"

printf "${BOLD}Syncing with remote...${NC}\n\n"
set +e
git -C "$repo_path" fetch origin >/dev/null 2>&1
git -C "$repo_path" fetch origin "+refs/tracy/*:refs/tracy/*" >/dev/null 2>&1
git -C "$repo_path" fetch origin "+refs/notes/commits:refs/notes/commits" >/dev/null 2>&1
fetch_status=$?
set -e

if [[ $fetch_status -ne 0 ]]; then
    printf "  [INFO] No remote tracing data found\n"
else
    printf "  ${G}[OK] Successfully fetched latest tracing data${NC}\n"
fi

echo ""

cat > "$tracy_dir/config" << EOF
TRACY_SCRIPT=$script_source
EOF

hooks_source="$(dirname "${BASH_SOURCE[0]}")/tracking/hooks"
hooks_dir="$git_dir/hooks"
mkdir -p "$hooks_dir"

printf "${BOLD}Installing Git Hooks:${NC}\n\n"
rows=()

for hook in pre-commit post-commit post-rewrite; do
    source_hook="$hooks_source/$hook"
    tracy_hook="$hooks_dir/${hook}.tracy"
    dest_hook="$hooks_dir/$hook"

    tracy_block=$(cat <<EOF
# --- TRACYBOT START ---
#
# !!! WARNING: DO NOT MODIFY OR REMOVE THIS BLOCK !!!
#
# This section is managed automatically by Tracybot.
# Any manual changes inside these markers may be overwritten.
# You may safely edit anything outside this block.

if [ -x "\$(dirname "\$0")/${hook}.tracy" ]; then
    "\$(dirname "\$0")/${hook}.tracy" "\$@"
fi

# --- TRACYBOT END ---
EOF
)

    if [[ -f "$dest_hook" ]]; then
        if grep -q "# --- TRACYBOT START ---" "$dest_hook"; then
            status="${G}Updated${NC}"
        else
            printf "${Y}WARNING: %s hook already exists.${NC}\n" "$hook"
            printf "Tracybot will preserve its current functionality.\n"
            printf "A backup of the original hook will be saved as ${B}%s.backup${NC}\n\n" "$hook"

            cp "$dest_hook" "${dest_hook}.backup"
            temp_file=$(mktemp)
                
            # Extract the shebang if it exists
            first_line=$(head -n 1 "$dest_hook")
            if [[ "$first_line" == "#!"* ]]; then
                echo "$first_line" > "$temp_file"
                echo "$tracy_block" >> "$temp_file"

                tail -n +2 "$dest_hook" >> "$temp_file"
            else
                echo "$tracy_block" > "$temp_file"
                cat "$dest_hook" >> "$temp_file"
            fi
                
            mv "$temp_file" "$dest_hook"
            chmod +x "$dest_hook"

            status="${Y}Backed up & Updated${NC}"
        fi
    else
        echo "#!/usr/bin/env bash" > "$dest_hook"
        echo "$tracy_block" >> "$dest_hook"
        chmod +x "$dest_hook"

        status="${G}Installed${NC}"
    fi

    cp "$source_hook" "$tracy_hook"
    chmod +x "$tracy_hook"

    rows+=("$(printf "| %-16s | %-40b |" "$hook" "$status")")
done

printf "+------------------+---------------------------------+\n"
printf "| %-16s | %-31s |\n" "Hook" "Status"
printf "+------------------+---------------------------------+\n"

for row in "${rows[@]}"; do
    printf "%b\n" "$row"
done

printf "+------------------+---------------------------------+\n\n"

printf "${G}******************************************************${NC}\n"
printf "${G}* SUCCESS: Tracybot is ready to go!                  *${NC}\n"
printf "${G}******************************************************${NC}\n"
echo ""

printf "${Y}Note:${NC} If the ${B}origin${NC} remote is changed or replaced,\n"
printf "you must re-run this initialization script, or manually reconfigure:\n\n"

printf "  git config --add remote.origin.push \"HEAD\"\n"
printf "  git config --add remote.origin.push \"refs/tracy/*:refs/tracy/*\"\n"
printf "  git config --add remote.origin.push \"refs/notes/commits:refs/notes/commits\"\n"
printf "  git config --add remote.origin.fetch \"+refs/heads/*:refs/remotes/origin/*\"\n"
printf "  git config --add remote.origin.fetch \"+refs/tracy/*:refs/tracy/*\"\n"
printf "  git config --add remote.origin.fetch \"+refs/notes/commits:refs/notes/commits\"\n"
echo ""

