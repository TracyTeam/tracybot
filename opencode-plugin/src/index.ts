import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import type { Part } from "@opencode-ai/sdk"
import type { Tasklet, PlanOutput, BuildOutput } from "./Tasklet"
import path from "path"

const PLUGIN_NAME = "tracybot-plugin"
const TASKLETS_FILE = path.join(__dirname, "../tasklets.json")

export const MyPlugin: Plugin = async (input: PluginInput) => {
    const { client, $, directory } = input

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

    let sessions = new Set<string>()
    
    async function saveTasklet(tasklet: Tasklet) {
        try {
            const file = Bun.file(TASKLETS_FILE)
            let existing: Tasklet[] = []

            if (await file.exists()) {
                try {
                    const text = await file.text()
                    if (text.trim()) {
                        existing = JSON.parse(text)
                    }
                } catch {
                    existing = []
                }
            } 
            existing.push(tasklet)
            await Bun.write(TASKLETS_FILE, JSON.stringify(existing, null, 2))

        } catch (error) {
            client.app.log({
                body: {
                    service: PLUGIN_NAME,
                    level: "error",
                    message: `Failed to save tasklet: ${error}` 
                }
            })
        }
    }

    async function createTasklet(sessionId: string) {
        const response = await client.session.messages({
            path: { id: sessionId}
        })
        const allMessages = response.data ?? []

        const getTextFromParts = (parts: Part[] | undefined): string => {
            if (!parts) return ""
            return parts
                .flatMap(part => part.type === "text" && part.text ? [part.text] : [])
                .join("\n\n---\n\n")

        } 
        
        const planOutputs: PlanOutput[] = []
        const planUserMsgs = allMessages.filter(
            (message) => message.info.role === "user" && message.info.agent !== "build"
        )

        for (const msgWrapper of planUserMsgs) {
            const userMsg = msgWrapper
            const userText = getTextFromParts(userMsg.parts)
            

            const assistantMsgs = allMessages.filter(
                (message) => message.info.role === "assistant" && 
                message.info.parentID === userMsg.info.id
            )

            const combinedResponse = assistantMsgs
                .map(message => getTextFromParts(message.parts))
                .filter(text => text)
                .join("\n\n---\n\n")
                
            planOutputs.push({
                id: `plan_${planOutputs.length}`,
                prompt: userText, 
                response: combinedResponse,
            })
        }
        
        const buildUserMsgs = allMessages.filter(
            (message) => message.info.role === "user" && message.info.agent === "build" 
        )
        
        const buildUserMsg = buildUserMsgs[0]
        if (!buildUserMsg) {
            client.app.log({
                body: {
                    service: PLUGIN_NAME,
                    level: "warn",
                    message: "Skipping tasklet creation: no build user message found"
                }
            })
            return
        }
        
        const buildAssistantMsgs = allMessages.filter(
            (message) => message.info.role === "assistant" &&
                        message.info.parentID === buildUserMsg.info.id
        )

        const combinedBuildResponse = buildAssistantMsgs
              .map(message => getTextFromParts(message.parts))
              .filter(text => text)
              .join("\n\n---\n\n")

        const buildOutput: BuildOutput = {
            id: `build_${Date.now()}`,
            prompt: getTextFromParts(buildUserMsg.parts),
            response: combinedBuildResponse, 
        }

        const tasklet: Tasklet = {
            id: `tasklet_${sessionId}_${Date.now()}`,
            sessionId,
            planOutputs,
            buildOutput
        }

        await saveTasklet(tasklet)
        
        client.app.log({
            body: {
                service: PLUGIN_NAME,
                level: "info",
                message: `Created tasklet: ${tasklet.id}`
            }
        })
    }

    return {

        event: async ({ event }) => {
            if (event.type === "session.created") {              
                const sessionId = event.properties?.info?.id
                if (sessionId) {
                    sessions.add(sessionId)
                }
                return
            }

            if (event.type === "session.deleted") {
                const sessionId = (event as any).properties.sessionID
                if (sessionId) {
                    sessions.delete(sessionId)
                }
            }
            
            if (event.type === "session.idle") {
                const idleSessionId = event.properties.sessionID
                if (sessions.has(idleSessionId)) {
                    await createTasklet(idleSessionId)
                }
            }
        },
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
                        message: `checkpoint: ${path}`,
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

                const commitMsg = `opencode: update ${path}`
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
    }
}
