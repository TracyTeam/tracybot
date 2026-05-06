#!/usr/bin/env node

import { execSync } from 'child_process'
import { readFileSync, rmSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const PLUGINS_DIR = join(homedir(), '.config', 'opencode', 'plugin')

function build() {
    console.log('Building plugin...')
    try {
        execSync('bun run build', { stdio: 'inherit' })
        console.log('✓ Build complete')
    } catch (error) {
        console.error('✗ Build failed')
        process.exit(1)
    }
}

function install() {
    const pluginsDir = PLUGINS_DIR
    console.log(`Installing to ${pluginsDir}...`)

    const distDir = 'dist'

    if (!existsSync(distDir)) {
        console.error('✗ dist/ directory not found. Run build first.')
        process.exit(1)
    }

    const srcPath = join(distDir, 'index.js')
    const destPath = join(pluginsDir, 'tracybot.js')

    if (existsSync(destPath)) {
        const stat = statSync(destPath)
        if (stat.isDirectory()) {
            console.log(`  Removing existing directory ${destPath}`)
            rmSync(destPath, { recursive: true, force: true })
        } else {
            console.log(`  Removing existing file ${destPath}`)
            rmSync(destPath, { force: true })
        }
    }

    console.log('  Copying files...')
    copyFileSync(srcPath, destPath)
    console.log('✓ Installation complete')
}

function main() {
    const args = process.argv.slice(2)
    const buildOnly = args.includes('--build-only') || args.includes('-b')
    const installOnly = args.includes('--install-only') || args.includes('-i')

    if (buildOnly) {
        build()
    } else if (installOnly) {
        install()
    } else {
        build()
        install()
    }
}

main()
