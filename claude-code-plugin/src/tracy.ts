import path from "path"

// Bun.$ (the shell API) is used as the ambient global here, matching how
// Bun.file/Bun.write/Bun.stdin are used elsewhere in this package — importing
// `{ $ } from "bun"` instead trips up tsup/esbuild, which doesn't know how to
// resolve Bun's built-in module specifier.
const $ = Bun.$

// Mirrors opencode-plugin/src/index.ts's resolveTracyPath — same config file,
// same handrolled parsing (dotenv isn't available, and this has to match the
// format tracking/hooks write, not something this package controls).
export async function resolveTracyPath(repoRoot: string): Promise<string | undefined> {
    if (process.env.TRACY_SNAPSHOT_SCRIPT) {
        return path.resolve(repoRoot, process.env.TRACY_SNAPSHOT_SCRIPT)
    }

    const configPath = path.join(repoRoot, ".git", "tracybot", "config")
    const configFile = Bun.file(configPath)

    if (!(await configFile.exists())) return

    const bytes = await configFile.bytes()
    let text: string
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
        text = new TextDecoder('windows-1252').decode(bytes)
    }
    const cleanedText = text.replace(/^﻿/, '');

    for (const line of cleanedText.split("\n")) {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith("#")) continue;

        const eqIndex = trimmedLine.indexOf("=");
        if (eqIndex === -1) continue;

        const key = trimmedLine.substring(0, eqIndex).trim();
        const value = trimmedLine.substring(eqIndex + 1).trim();

        if (key && value !== undefined) {
            process.env[key] = value.replace(/\r/g, '');
        }
    }

    if (!process.env.TRACY_SNAPSHOT_SCRIPT) return
    return path.resolve(repoRoot, process.env.TRACY_SNAPSHOT_SCRIPT)
}

export async function detectPythonCommand(): Promise<string | undefined> {
    if ((await $`python3 --version`.quiet().nothrow()).exitCode === 0) {
        return "python3"
    }
    if ((await $`python --version`.quiet().nothrow()).exitCode === 0) {
        return "python"
    }
    return undefined
}

export async function getRepoRoot(cwd: string): Promise<string | undefined> {
    try {
        const result = await $`git rev-parse --show-toplevel`.cwd(cwd).quiet()
        return result.stdout.toString('utf8').trim()
    } catch {
        return undefined
    }
}

// The hook event's own `cwd` is not a reliable "which repo is this turn
// about" signal — it reflects whatever the session's shell happens to be in
// at Stop time, which drifts on an ordinary `cd` (e.g. running a diagnostic
// command in a different repo) with no actual edit involved. The edited
// files themselves are the only ground truth for that, so the repo root is
// derived from them instead — tried in order in case an earlier one no
// longer resolves (e.g. a since-deleted file).
export async function getRepoRootForEditedFiles(editedFiles: string[]): Promise<string | undefined> {
    for (const file of editedFiles) {
        const repoRoot = await getRepoRoot(path.dirname(file))
        if (repoRoot) return repoRoot
    }
    return undefined
}

// Same shape of call opencode-plugin makes — tracy.py itself doesn't care
// which agent produced the description, only that it's a string.
export async function runTracySnapshot(
    pythonCmd: string,
    tracyPath: string,
    repoRoot: string,
    description: string,
    sessionId: string
): Promise<string> {
    const result = await $`${pythonCmd} ${tracyPath} --user-name "claude-code" --user-email "claude-code" --description ${description} --session-id ${sessionId}`
        .cwd(repoRoot)
        .text()
    return result
}
