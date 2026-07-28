#!/usr/bin/env node

import { execSync } from 'child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'

const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json')
const DIST_PATH = resolve('dist', 'tracybot-cc-hook.js')

function build() {
    console.log('Building plugin...')
    try {
        execSync('bun run build', { stdio: 'inherit' })
        console.log('✓ Build complete')
    } catch {
        console.error('✗ Build failed')
        process.exit(1)
    }
}

function loadSettings() {
    if (!existsSync(SETTINGS_PATH)) return {}
    try {
        return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
    } catch {
        console.error(`✗ ${SETTINGS_PATH} exists but isn't valid JSON — not touching it. Fix or remove it, then re-run.`)
        process.exit(1)
    }
}

// Bun-specific APIs are used throughout (Bun.file, Bun.$, Bun.stdin) — these
// hooks run under `bun`, not plain `node`, unlike opencode-plugin which
// OpenCode itself loads directly. Resolved to an absolute path rather than
// the bare `bun` command: hook execution environments aren't guaranteed to
// have the same PATH as an interactive shell (e.g. ~/.bun/bin from a
// curl-installed Bun may only be on PATH via .zshrc, which a hook's
// subprocess won't source), so relying on PATH here can silently no-op.
function resolveBunPath() {
    try {
        return execSync('command -v bun', { encoding: 'utf8' }).trim()
    } catch {
        const fallback = join(homedir(), '.bun', 'bin', 'bun')
        if (existsSync(fallback)) return fallback
        console.error('✗ Could not find the bun executable. Install it from https://bun.sh, then re-run.')
        process.exit(1)
    }
}

function hookCommand(event) {
    return `${resolveBunPath()} ${DIST_PATH} ${event}`
}

function hasCommand(hookList, command) {
    return (hookList ?? []).some(entry => (entry.hooks ?? []).some(h => h.command === command))
}

function installHooks(settings) {
    settings.hooks ??= {}

    settings.hooks.PostToolUse ??= []
    const postToolUseCommand = hookCommand('post-tool-use')
    if (!hasCommand(settings.hooks.PostToolUse, postToolUseCommand)) {
        settings.hooks.PostToolUse.push({
            matcher: 'Edit|Write|MultiEdit',
            hooks: [{ type: 'command', command: postToolUseCommand }],
        })
        console.log('  Added PostToolUse hook')
    } else {
        console.log('  PostToolUse hook already present')
    }

    settings.hooks.Stop ??= []
    const stopCommand = hookCommand('stop')
    if (!hasCommand(settings.hooks.Stop, stopCommand)) {
        settings.hooks.Stop.push({
            hooks: [{ type: 'command', command: stopCommand }],
        })
        console.log('  Added Stop hook')
    } else {
        console.log('  Stop hook already present')
    }

    return settings
}

function main() {
    const args = process.argv.slice(2)
    if (!args.includes('--install-only') && !args.includes('-i')) {
        build()
    }

    if (!existsSync(DIST_PATH)) {
        console.error('✗ Built plugin not found. Run build first.')
        process.exit(1)
    }

    mkdirSync(join(homedir(), '.claude'), { recursive: true })
    const settings = installHooks(loadSettings())
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n')
    console.log(`✓ Hooks installed in ${SETTINGS_PATH}`)
}

main()
