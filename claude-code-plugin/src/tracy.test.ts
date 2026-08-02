import { test, expect, afterEach } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs"
import { getRepoRoot, getRepoRootForEditedFiles } from "./tracy"

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
