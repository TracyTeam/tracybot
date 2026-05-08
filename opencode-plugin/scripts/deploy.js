#!/usr/bin/env node

import { execSync } from 'child_process'
import { readFileSync, rmSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'fs'
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
    const srcPath = join(distDir, 'tracybot-oc.js')

    if (!existsSync(distDir) || !existsSync(srcPath)) {
        console.error('✗ Built plugin not found. Run build first.')
        process.exit(1)
    }

    const destPath = join(pluginsDir, 'tracybot-oc.js')

    if (!existsSync(pluginsDir)) {
        mkdirSync(pluginsDir)
        console.log(`  Created plugins directory ${pluginsDir}`)
    }

    if (existsSync(destPath)) {
        console.log(`  Removing existing file ${destPath}`)
        rmSync(destPath, { force: true })
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
