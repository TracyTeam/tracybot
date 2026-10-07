import { test, expect, afterEach } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs"
import { getRepoRoot, getRepoRootForEditedFiles, getFirstRepoRoot, getLatestSnapshot } from "./tracy"

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
