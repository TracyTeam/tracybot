import type { Plugin } from "@opencode-ai/plugin"

const PLUGIN_NAME = "tracybot-plugin"

export const MyPlugin: Plugin = async ({ project, client, $, directory }) => {
    await client.app.log({
        body: {
            service: PLUGIN_NAME,
            level: "info",
            message: "Plugin initialized",
        },
    })

    async function getRepoRoot(): Promise<string | null> {
        try {
            const result = await $`git rev-parse --show-toplevel`.cwd(directory)
            return String(result.stdout).trim() as string
        } catch {
            return null
        }
    }

    const repoRoot = await getRepoRoot()
    if (!repoRoot) {
        await client.app.log({
            body: {
                service: PLUGIN_NAME,
                level: "warn",
                message: "Not a git repo",
            },
        })
        throw new Error("Not a git repo");
    }

    const EDIT_TOOLS = ["edit", "write"]

    return {
        "tool.execute.before": async (input, output) => {
            if (!EDIT_TOOLS.includes(input.tool)) return

            const path = output.args.filePath as string | undefined
            if (!path) {
                await client.app.log({
                    body: {
                        service: PLUGIN_NAME,
                        level: "error",
                        message: `skill issue: missing path in before hook`,
                        extra: { input, output },
                    },
                })
                return
            }

            try {
                await $`git add ${path}`.cwd(repoRoot).quiet()
                await $`git commit -m "user checkpoint"`.cwd(repoRoot).quiet()

                await client.app.log({
                    body: {
                        service: PLUGIN_NAME,
                        level: "info",
                        message: `Created user checkpoint for ${path}`,
                    },
                })
            }
            catch (e: any) {
                if (e.exitCode === 1 || String(e).includes("exit code 1")) {
                    await client.app.log({
                        body: {
                            service: PLUGIN_NAME,
                            level: "info",
                            message: `no pre-existing changes for ${path}, skipping checkpoint`,
                        },
                    })
                    return
                }

                await client.app.log({
                    body: {
                        service: PLUGIN_NAME,
                        level: "error",
                        message: `skill issue: ${e}`,
                    },
                })
            }
        },


        "tool.execute.after": async (input, output) => {
            if (!EDIT_TOOLS.includes(input.tool)) return

            const path = input.args.filePath as string | undefined
            if (!path) {
                await client.app.log({
                    body: {
                        service: PLUGIN_NAME,
                        level: "error",
                        message: `skill issue: missing path in after hook`,
                        extra: { input, output },
                    },
                })
                return
            }

            try {
                await $`git add ${path}`.cwd(repoRoot).quiet()

                const commitMsg = "opencode"
                await $`git -c "user.name=opencode" -c "user.email=opencode@oc.ai" commit -m ${commitMsg}`.cwd(repoRoot).quiet()

                await client.app.log({
                    body: {
                        service: PLUGIN_NAME,
                        level: "info",
                        message: `Committed OC changes for ${path}`,
                    },
                })
            }
            catch (e) {
                await client.app.log({
                    body: {
                        service: PLUGIN_NAME,
                        level: "error",
                        message: `skill issue: ${e}`,
                    },
                })
            }
        },

        // event: async ({ event }) => {
        //     if (event.type == "session.diff") {
        //         const diffs = event.properties?.diff ?? []
        //
        //         if (diffs.length === 0) return
        //
        //         // TODO: figure out getting the prompt(s) here
        //         const commitMsg = "opencode"
        //         try {
        //             // commit changes staged from pre-edit to create user checkpoint
        //             await client.app.log({
        //                 body: {
        //                     service: PLUGIN_NAME,
        //                     level: "info",
        //                     message: "saved user checkpoint",
        //                     extra: { diff: await $`git show`.cwd(repoRoot).quiet() },
        //                 },
        //             })
        //
        //             const files = diffs.map((d: any) => d.file) // stage only changed files
        //             await $`git add ${files}`.cwd(repoRoot).quiet()
        //             await $`git commit -m ${commitMsg} -c "user.name=opencode" -c "user.email=opencode@oc.ai" `.cwd(repoRoot).quiet()
        //
        //             await client.app.log({
        //                 body: {
        //                     service: PLUGIN_NAME,
        //                     level: "info",
        //                     message: "Committed OC changes",
        //                     extra: { files },
        //                 },
        //             })
        //         }
        //         catch (e) {
        //             await client.app.log({
        //                 body: {
        //                     service: PLUGIN_NAME,
        //                     level: "error",
        //                     message: `skill issue: ${e}`,
        //                 },
        //             })
        //         }
        //
        //         // const diffs = event.properties?.diff ?? []
        //         //
        //         // if (diffs.length === 0) return
        //         //
        //         // try {
        //         //     const files = diffs.map((d: any) => d.file) // stage only changed files
        //         //     await $`git add --quiet ${files}`.cwd(repoRoot)
        //         //
        //         //     const message = `opencode: apply ${files.length} change(s)\n\n${files.join("\n")}`
        //         //     await $`git commit --quiet -c "user.name=opencode" -c "user.email=opencode@oc.ai" -m ${message}`.cwd(repoRoot)
        //         //
        //         //     await client.app.log({
        //         //         body: {
        //         //             service: PLUGIN_NAME,
        //         //             level: "info",
        //         //             message: "Committed changes",
        //         //             extra: { files },
        //         //         },
        //         //     })
        //         // } catch (err) {
        //         //     await client.app.log({
        //         //         body: {
        //         //             service: PLUGIN_NAME,
        //         //             level: "error",
        //         //             message: "Git commit failed",
        //         //             extra: { error: String(err) },
        //         //         },
        //         //     })
        //         // }
        //     }
        // },
    }

}
