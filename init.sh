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
        printf "\n${R}*********************************${NC}\n"
        printf "${R}* ERROR: No git repository found *${NC}\n"
        printf "${R}**********************************${NC}\n\n"
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
        printf "\n${R}!! ERROR: Tracybot requires a git repository !!${NC}\n"
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

printf "+----------------------------------------------------+\n"
printf "| [DONE] Git notes rewriting configured              |\n"
printf "+----------------------------------------------------+\n\n"

cat > "$tracy_dir/config" << EOF
TRACY_SCRIPT=$script_source
EOF

hooks_source="$(dirname "${BASH_SOURCE[0]}")/tracking/hooks"
hooks_dir="$git_dir/hooks"
mkdir -p "$hooks_dir"

printf "${BOLD}Installing Git Hooks:${NC}\n\n"
rows=()

for hook in pre-commit post-commit post-rewrite pre-push; do
    source_hook="$hooks_source/$hook"
    dest_hook="$hooks_dir/$hook"

    if [[ -f "$dest_hook" ]]; then
        printf "${Y}WARNING: %s hook already exists.${NC}\n" "$hook"
        printf "Existing hook will be backed up to ${B}%s.backup${NC}\n" "$hook"
        printf "Continue with overwrite? (y/n) "
        read -n 1 -r REPLY

        while [[ "$REPLY" == "" || -z "$REPLY" ]]; do
            printf "Continue with overwrite? (y/n) "
            read -n 1 -r REPLY
        done

        echo -e "\n"

        if [[ "$REPLY" =~ ^[Yy]$ ]]; then
            mv "$dest_hook" "${dest_hook}.backup"
            status="${Y}Backed up & Updated${NC}"
        else
            printf "${R}Initialization aborted.${NC}\n"
            exit 0
        fi
    else
        status="${G}Installed${NC}"
    fi

    cp "$source_hook" "$dest_hook"
    chmod +x "$dest_hook"

    rows+=("$(printf "| %-16s | %-40b |" "$hook" "$status")")
done

printf "+------------------+---------------------------------+\n"
printf "| %-16s | %-31s |\n" "Hook" "Status"
printf "+------------------+---------------------------------+\n"

for row in "${rows[@]}"; do
    printf "%b\n" "$row"
done

printf "+------------------+---------------------------------+\n\n"

git -C "$repo_path" config alias.fetch-tracy '!f() { \
    printf "Fetching Tracybot data from remote...\n"; \
    set +e; \
    git fetch origin >/dev/null 2>&1; \
    git fetch origin "+refs/tracy/*:refs/remotes/origin/tracy/*" >/dev/null 2>&1; \
    git fetch origin "+refs/notes/commits:refs/notes/commits" >/dev/null 2>&1; \
    if [[ $? -ne 0 ]]; then \
        printf "No tracing changes found on remote.\n"; \
    else \
        printf "Fetched latest tracing changes successfully.\n"; \
    fi; \
    set -e; \
}; f'

printf "${G}*************************************${NC}\n"
printf "${G}* SUCCESS: Tracybot is ready to go! *${NC}\n"
printf "${G}*************************************${NC}\n"
echo ""
printf "${BOLD}New command:${NC}\n"
printf "Run ${B}git fetch-tracy${NC} to pull the latest AI tracking data."
echo ""