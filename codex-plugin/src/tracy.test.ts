import { test, expect, afterEach } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs"
import { resolveTracyPath } from "./tracy"

const $ = Bun.$

const tmpDirs: string[] = []

afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})


async function makeCommittedRepo(): Promise<string> {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tracy-gitdir-test-")))
    tmpDirs.push(dir)
    await $`git init -q -b main && git config user.email t@e.com && git config user.name T`.cwd(dir).quiet()
    fs.writeFileSync(path.join(dir, "a.txt"), "x\n")
    await $`git add -A && git commit -q -m init`.cwd(dir).quiet()
    return dir
}

// Asks git itself where the shared git dir is, rather than assuming ".git",
// so the test also checks resolveTracyPath against git's own answer.
async function writeTracyConfig(repo: string, script: string): Promise<void> {
    const common = (await $`git rev-parse --git-common-dir`.cwd(repo).text()).trim()
    const gitDir = path.resolve(repo, common)
    fs.mkdirSync(path.join(gitDir, "tracybot"), { recursive: true })
    fs.writeFileSync(path.join(gitDir, "tracybot", "config"), `TRACY_SNAPSHOT_SCRIPT=${script}\n`)
}

test("resolveTracyPath finds the config of a normal repo", async () => {
    delete process.env.TRACY_SNAPSHOT_SCRIPT
    const repo = await makeCommittedRepo()
    await writeTracyConfig(repo, "/opt/tracy.py")

    expect(await resolveTracyPath(repo)).toBe("/opt/tracy.py")
})

test("resolveTracyPath finds the config from a linked worktree, where .git is a file", async () => {
    delete process.env.TRACY_SNAPSHOT_SCRIPT
    const main = await makeCommittedRepo()
    await writeTracyConfig(main, "/opt/tracy.py")
    const linked = path.join(path.dirname(main), `linked-${path.basename(main)}`)
    tmpDirs.push(linked)
    await $`git worktree add -q ${linked} -b feat`.cwd(main).quiet()
    expect(fs.statSync(path.join(linked, ".git")).isFile()).toBe(true)

    expect(await resolveTracyPath(linked)).toBe("/opt/tracy.py")
})

test("resolveTracyPath finds the config from a submodule, where .git is a file", async () => {
    delete process.env.TRACY_SNAPSHOT_SCRIPT
    const lib = await makeCommittedRepo()
    const main = await makeCommittedRepo()
    await $`git -c protocol.file.allow=always submodule add -q ${lib} sub`.cwd(main).quiet()
    const sub = path.join(main, "sub")
    expect(fs.statSync(path.join(sub, ".git")).isFile()).toBe(true)
    await writeTracyConfig(sub, "/opt/tracy.py")
    // the config lives in the submodule's real git dir, not under sub/.git
    expect(fs.existsSync(path.join(sub, ".git", "tracybot"))).toBe(false)

    expect(await resolveTracyPath(sub)).toBe("/opt/tracy.py")
})
