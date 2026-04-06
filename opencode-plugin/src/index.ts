import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import type { Part } from "@opencode-ai/sdk"
import type { Tasklet, PlanOutput, BuildOutput } from "./Tasklet"
import path from "path"
import { Logger } from "./Logger"

const TASKLETS_FILE = path.join(__dirname, "../tasklets.json")
const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit", "apply_patch", "applypatch"])

export const MyPlugin: Plugin = async (input: PluginInput) => {
    const { client, $, directory } = input
    const L = new Logger(client)

    async function getRepoRoot(): Promise<string | null> {
        try {
            const result = await $`git rev-parse --show-toplevel`.cwd(directory).quiet()
            return String(result.stdout).trim() as string
        } catch {
            return null
        }
    }

    const repoRoot = await getRepoRoot()
    if (!repoRoot) {
        await L.error("Not a git repo")
        return {} // No-op
    }

    async function resolveTracyPath(repoRoot: string): Promise<string | undefined> {
        // support passing from shell instead of file
        if (process.env.TRACY_SCRIPT) {
            return process.env.TRACY_SCRIPT
        }

        const configPath = path.join(repoRoot, ".git", "tracybot", "config")
        const configFile = Bun.file(configPath)

        if (!(await configFile.exists())) return // no env and no config = bye

        // cannot use dotenv, so enjoy this handrolled env parsing
        const text = await configFile.text()
        for (const line of text.split("\n")) {
            const match = line.match(/^([^=]+)=(.*)$/)
            if (match && match[1] && match[2]) {
                process.env[match[1].trim()] = match[2].trim()
            }
        }

        return process.env.TRACY_SCRIPT
    }

    const tracyPath = await resolveTracyPath(repoRoot)
    const isInstalled = tracyPath ? await Bun.file(tracyPath).exists() : false

    if (!isInstalled || !tracyPath) {
        await L.error("tracy.sh not found")
        return {} // No-op
    }

    await L.info("Plugin initialized", { repoRoot, tracyPath })


    let sessions = new Set<string>()

    async function createTasklet(sessionId: string): Promise<Tasklet | undefined> {
        const response = await client.session.messages({
            path: { id: sessionId }
        })
        const allMessages = response.data ?? []

        const getTextFromParts = (parts: Part[] | undefined): string => {
            if (!parts) return ""
            return parts
                .flatMap(part => part.type === "text" && part.text ? [part.text] : [])
                .join("\n\n---\n\n")
        }

        const planOutputs: PlanOutput[] = allMessages
            .filter((message) => message.info.role === "user" && message.info.agent !== "build")
            .map((userMsg, idx) => {
                const assistantMsgs = allMessages.filter((message) =>
                    message.info.role === "assistant" && message.info.parentID === userMsg.info.id)

                const userText = getTextFromParts(userMsg.parts)
                const combinedResponse = assistantMsgs
                    .map(msg => getTextFromParts(msg.parts))
                    .filter(text => text)
                    .join("\n\n---\n\n")

                return {
                    id: `plan_${idx}`,
                    prompt: userText,
                    response: combinedResponse,
                }
            })

        const buildUserMsg = allMessages.find(
            (message) => message.info.role === "user" && message.info.agent === "build"
        )

        if (!buildUserMsg) {
            return
        }

        const buildAssistantMsgs = allMessages.filter(
            (message) => message.info.role === "assistant" &&
                message.info.parentID === buildUserMsg.info.id
        )

        const buildOutput: BuildOutput = {
            id: `build_${planOutputs.length}`,
            prompt: getTextFromParts(buildUserMsg.parts),
            response: buildAssistantMsgs
                .map(message => getTextFromParts(message.parts))
                .filter(text => text)
                .join("\n\n---\n\n"),
        }

        const tasklet: Tasklet = {
            id: `tasklet_${sessionId}_${Date.now()}`,
            sessionId,
            planOutputs,
            buildOutput
        }

        await L.info(`Created tasklet: ${tasklet.id}`)
        return tasklet
    }

    return {
        event: async ({ event }) => {
            if (event.type === "session.created") {
                const sessionId = event.properties.info.id
                if (sessionId) {
                    sessions.add(sessionId)
                }
                return
            }

            if (event.type === "session.deleted") {
                const sessionId = event.properties.info.id
                if (sessionId) {
                    sessions.delete(sessionId)
                }
            }

            if (event.type === "session.idle") {
                const idleSessionId = event.properties.sessionID
                if (sessions.has(idleSessionId)) {
                    const tasklet = createTasklet(idleSessionId) // TODO: CACHE THIS PLEASE FOR THE LOVE OF GOD
                    if (!tasklet) {
                        await L.warn("Skipping tasklet creation: no build user message found")
                        return
                    }

                    await $`${tracyPath} --user-name "opencode" --user-email "opencode" --description ${JSON.stringify(tasklet)}`.cwd(repoRoot).quiet()
                    await L.info(`committed OC changes for ${path}`)
                }
            }
        },

        "tool.execute.before": async (input, output) => {
            if (!EDIT_TOOLS.has(input.tool)) return

            const path = output.args.filePath as string | undefined
            if (!path) {
                await L.error(`skill issue: missing pth in tool.execute.before hook`, { input, output })
                return
            }

            try {
                await $`${tracyPath}`.cwd(repoRoot).quiet() // user snapshot
                await L.info(`created user snapshot for ${path}`)
            }
            catch (e: any) {
                L.error(`skill issue: ${e}`)
            }
        },
    }
}
