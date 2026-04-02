import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import type { Tasklet, PlanOutput, BuildOutput } from "./tasklet"
import fs from "fs"
import path from "path"

const PLUGIN_NAME = "tracybot-plugin"
const TASKLETS_FILE = path.join(__dirname, "../tasklets.json")

interface MessageState {
    parentId: string
    id: string
    role: string
    agent: string
    text: string
}

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

    const messages: Map<string, MessageState> = new Map()
    let currentSessionId = ""
    let taskletCounter = 0
    
    function saveTasklet(tasklet: Tasklet) {
        let existing: Tasklet[] = []
        try {
            if (fs.existsSync(TASKLETS_FILE)) {
                try {
                    existing = JSON.parse(fs.readFileSync(TASKLETS_FILE, "utf-8"))
                } catch {
                    existing = []
                }
            } 
            existing.push(tasklet)
            fs.writeFileSync(TASKLETS_FILE, JSON.stringify(existing, null, 2))

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

    function createTasklet(sessionId: string, buildMsg: MessageState) {
        const planOutputs: PlanOutput[] = []
        
        const allMessages = Array.from(messages.values())
        const messagesById = new Map(allMessages.map(message => [message.id, message]))

        for (const msg of allMessages) {
            if (msg.role === "user" && msg.agent === "build") continue
            if (msg.role === "user" && msg.agent !== "build") {
                const assistantMsg = Array.from(messagesById.values()).find(
                    (message) => message.role === "assistant" && message.parentId === msg.id
                )
                if(assistantMsg) {
                    planOutputs.push({
                        id: `plan_${planOutputs.length}`,
                        prompt: msg.text, 
                        response: assistantMsg?.text || "",
                    })
                }
            }
        }

        const buildUserMsg = allMessages.find(
            (message) => message.role === "user" && message.agent === "build" 
        )
        if (!buildUserMsg) return

        const buildOutput: BuildOutput = {
            id: `build_${taskletCounter}`,
            prompt: buildUserMsg?.text || "",
            response: buildMsg.text, 
        }

        const tasklet: Tasklet = {
            id: `tasklet_${sessionId}_${taskletCounter}`,
            sessionId,
            planOutputs,
            buildOutput
        }

        saveTasklet(tasklet)
        taskletCounter++
        messages.clear()
        
        client.app.log({
            body: {
                service: PLUGIN_NAME,
                level: "info",
                message: `Created tasklet: ${tasklet.id}`
            }
        })
    }

    return {

        event: async (input: any) => {
            const { event } = input
            if (event.type === "session.created") {              
                currentSessionId = event.properties?.info?.id || ""
                messages.clear()
                taskletCounter = 0
                return
            }
            
            if (event.type === "message.part.updated" && event.properties?.part) {
                const part = event.properties.part
                if (part.type === "text" && part.text) {
                    const msgId = part.messageID
                    const msg = messages.get(msgId)
                    if (msg) {
                        msg.text = part.text
                    
                        if (msg.role === "assistant" && msg.agent === "build") {
                            createTasklet(currentSessionId, msg)
                        }
                    }

                }
                
            }

            if (event.type === "message.updated" && event.properties?.info) {
                const info = event.properties.info
                const msgId = info?.id 
                if (!msgId) return
    
                const role = info.role || ""
                const agent = info.agent || "plan"
                const parentId = info.parentID
                
                const existingMsg = messages.get(msgId)
                messages.set(msgId, {
                    parentId,
                    id: msgId,
                    role,
                    agent,
                    text: existingMsg?.text || "",
                })
            
                if (role === "assistant" && parentId) {
                    const parentMsg = messages.get(parentId)
                    if (parentMsg && parentMsg.role === "user") {
                        parentMsg.agent = agent
                    }
                }
                return
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
