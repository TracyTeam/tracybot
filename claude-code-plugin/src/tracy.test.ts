import { test, expect, afterEach } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs"
import { getRepoRoot, getRepoRootForEditedFiles, getFirstRepoRoot, getLatestSnapshot, resolveTracyPath, getWorkingTreeHash } from "./tracy"

const $ = Bun.$

const tmpDirs: string[] = []

afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

async function makeRepo(): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracy-repo-test-"))
    tmpDirs.push(dir)
    await $`git init -q`.cwd(dir).quiet()
    return dir
}

test("getRepoRootForEditedFiles resolves the repo containing the edited files, ignoring an unrelated cwd", async () => {
    const repoA = await makeRepo()
    const repoB = await makeRepo()

    const editedFile = path.join(repoA, "src", "file.ts")
    fs.mkdirSync(path.dirname(editedFile), { recursive: true })
    fs.writeFileSync(editedFile, "// edited")

    // This mirrors the real bug: a session's shell cwd (repoB) drifting away
    // from where the actual edits happened (repoA) must not affect which
    // repo gets snapshotted.
    const resolvedFromCwd = await getRepoRoot(repoB)
    const resolvedFromEditedFiles = await getRepoRootForEditedFiles([editedFile])

    expect(resolvedFromCwd).toBe(fs.realpathSync(repoB))
    expect(resolvedFromEditedFiles).toBe(fs.realpathSync(repoA))
    expect(resolvedFromEditedFiles).not.toBe(resolvedFromCwd)
})

test("getRepoRootForEditedFiles falls back to a later file if an earlier one no longer resolves", async () => {
    const repo = await makeRepo()
    const missingFile = path.join(os.tmpdir(), "tracy-repo-test-does-not-exist", "gone.ts")
    const realFile = path.join(repo, "real.ts")
    fs.writeFileSync(realFile, "// real")

    const resolved = await getRepoRootForEditedFiles([missingFile, realFile])
    expect(resolved).toBe(fs.realpathSync(repo))
})

test("getRepoRootForEditedFiles returns undefined when no edited file resolves to a repo", async () => {
    const outsideAnyRepo = fs.mkdtempSync(path.join(os.tmpdir(), "tracy-no-repo-test-"))
    tmpDirs.push(outsideAnyRepo)
    const file = path.join(outsideAnyRepo, "orphan.ts")
    fs.writeFileSync(file, "// orphan")

    const resolved = await getRepoRootForEditedFiles([file])
    expect(resolved).toBeUndefined()
})

test("getFirstRepoRoot resolves the first directory that is inside a repo", async () => {
    const outsideAnyRepo = fs.mkdtempSync(path.join(os.tmpdir(), "tracy-no-repo-test-"))
    tmpDirs.push(outsideAnyRepo)
    const repo = await makeRepo()

    expect(await getFirstRepoRoot([outsideAnyRepo, repo])).toBe(fs.realpathSync(repo))
})

test("getLatestSnapshot returns the head of the current snapshot chain, or undefined when there is none", async () => {
    const repo = await makeRepo()
    expect(await getLatestSnapshot(repo)).toBeUndefined()

    const tree = (await $`git write-tree`.cwd(repo).text()).trim()
    const commit = (await $`git commit-tree ${tree} -m snapshot`.cwd(repo).env({ ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t" }).text()).trim()
    await $`git config tracy.current-id chain-1`.cwd(repo).quiet()
    await $`git update-ref refs/tracy-local/chain-1 ${commit}`.cwd(repo).quiet()

    expect(await getLatestSnapshot(repo)).toBe(commit)
})

// ---- .git is a file (linked worktree / submodule) ----

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

// ---- getWorkingTreeHash ----

const TRACY_PY = path.resolve(import.meta.dir, "..", "..", "tracking", "tracy.py")

test("getWorkingTreeHash is stable for an unchanged tree and changes with any edit, including a new untracked file", async () => {
    const repo = await makeCommittedRepo()
    const clean = await getWorkingTreeHash(repo)
    expect(clean).toBeDefined()
    expect(await getWorkingTreeHash(repo)).toBe(clean)

    fs.writeFileSync(path.join(repo, "a.txt"), "changed\n")
    const edited = await getWorkingTreeHash(repo)
    expect(edited).not.toBe(clean)

    fs.writeFileSync(path.join(repo, "new.txt"), "untracked\n")
    expect(await getWorkingTreeHash(repo)).not.toBe(edited)
})

test("getWorkingTreeHash respects .gitignore", async () => {
    const repo = await makeCommittedRepo()
    fs.writeFileSync(path.join(repo, ".gitignore"), "build/\n")
    const before = await getWorkingTreeHash(repo)

    fs.mkdirSync(path.join(repo, "build"))
    fs.writeFileSync(path.join(repo, "build", "out.js"), "generated\n")
    expect(await getWorkingTreeHash(repo)).toBe(before)
})

test("getWorkingTreeHash leaves the user's real index alone", async () => {
    const repo = await makeCommittedRepo()
    fs.writeFileSync(path.join(repo, "a.txt"), "changed but not staged\n")
    fs.writeFileSync(path.join(repo, "new.txt"), "untracked\n")
    const statusBefore = (await $`git status --porcelain`.cwd(repo).text())
    const indexBefore = fs.readFileSync(path.join(repo, ".git", "index"))

    await getWorkingTreeHash(repo)

    expect(await $`git status --porcelain`.cwd(repo).text()).toBe(statusBefore)
    expect(fs.readFileSync(path.join(repo, ".git", "index")).equals(indexBefore)).toBe(true)
})

test("getWorkingTreeHash equals the tree tracy.py snapshots for the same working directory", async () => {
    const repo = await makeCommittedRepo()
    fs.writeFileSync(path.join(repo, "a.txt"), "changed\n")
    fs.writeFileSync(path.join(repo, "new.txt"), "untracked\n")
    const predicted = await getWorkingTreeHash(repo)

    await $`python3 ${TRACY_PY} --user-name claude-code --user-email claude-code --description {} --session-id s1`.cwd(repo).quiet()
    const tracyId = (await $`git config --get tracy.current-id`.cwd(repo).text()).trim()
    const snapshotTree = (await $`git rev-parse refs/tracy-local/${tracyId}^{tree}`.cwd(repo).text()).trim()

    expect(predicted).toBe(snapshotTree)
})

test("getWorkingTreeHash works from a linked worktree, where .git is a file", async () => {
    const main = await makeCommittedRepo()
    const linked = path.join(path.dirname(main), `linked-${path.basename(main)}`)
    tmpDirs.push(linked)
    await $`git worktree add -q ${linked} -b feat`.cwd(main).quiet()

    const clean = await getWorkingTreeHash(linked)
    expect(clean).toBeDefined()
    fs.writeFileSync(path.join(linked, "a.txt"), "changed in the worktree\n")
    expect(await getWorkingTreeHash(linked)).not.toBe(clean)
})

