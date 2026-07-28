#!/usr/bin/env node

import { execSync } from 'child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'

const HOOKS_PATH = join(homedir(), '.codex', 'hooks.json')
const DIST_PATH = resolve('dist', 'tracybot-codex-hook.js')

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

function loadHooksFile() {
    if (!existsSync(HOOKS_PATH)) return {}
    try {
        return JSON.parse(readFileSync(HOOKS_PATH, 'utf8'))
    } catch {
        console.error(`✗ ${HOOKS_PATH} exists but isn't valid JSON — not touching it. Fix or remove it, then re-run.`)
        process.exit(1)
    }
}

// Same rationale as claude-code-plugin's deploy.js: resolve an absolute path
// rather than relying on `bun` being on PATH in the hook's execution
// environment, which isn't guaranteed to match an interactive shell's PATH.
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

function installHooks(config) {
    config.hooks ??= {}

    config.hooks.PostToolUse ??= []
    const postToolUseCommand = hookCommand('post-tool-use')
    if (!hasCommand(config.hooks.PostToolUse, postToolUseCommand)) {
        config.hooks.PostToolUse.push({
            matcher: 'apply_patch|Edit|Write',
            hooks: [{ type: 'command', command: postToolUseCommand }],
        })
        console.log('  Added PostToolUse hook')
    } else {
        console.log('  PostToolUse hook already present')
    }

    config.hooks.Stop ??= []
    const stopCommand = hookCommand('stop')
    if (!hasCommand(config.hooks.Stop, stopCommand)) {
        config.hooks.Stop.push({
            hooks: [{ type: 'command', command: stopCommand }],
        })
        console.log('  Added Stop hook')
    } else {
        console.log('  Stop hook already present')
    }

    return config
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

    mkdirSync(join(homedir(), '.codex'), { recursive: true })
    const config = installHooks(loadHooksFile())
    writeFileSync(HOOKS_PATH, JSON.stringify(config, null, 2) + '\n')
    console.log(`✓ Hooks installed in ${HOOKS_PATH}`)
}

main()
