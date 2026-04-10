import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import type { Part } from "@opencode-ai/sdk"
import type { Tasklet, PlanOutput, BuildOutput, Question } from "./Tasklet"
import path from "path"
import { Logger } from "./Logger"

const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit", "apply_patch", "applypatch", "question"])

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

    async function getPlanOutputs(sessionId: string): Promise<PlanOutput[]>{
        const response = await client.session.messages({
            path: {id: sessionId}
        })

        const allMessages = response.data ?? []

        const getTextFromParts = (parts: Part[] | undefined): string => {
            if (!parts) return ""
            return parts
                .flatMap(part => part.type === "text" && part.text ? [part.text] : [])
                .join("\n\n---\n\n")
        }

        return allMessages
            .filter((message) => message.info.role === "user" && message.info.agent !== "build")
            .map((userMsg, idx) => {
                const assistantMsgs = allMessages.filter((message) =>
                    message.info.role === "assistant" && message.info.parentID === userMsg.info.id)

                return {
                    id: `plan_${idx}`,
                    prompt: getTextFromParts(userMsg.parts),
                    response: assistantMsgs
                    .map(msg => getTextFromParts(msg.parts))
                    .filter(text => text)
                    .join("\n\n---\n\n"),
                }
            })
 
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
    const snapshotLocks = new Map<string, Promise<void>>()

    const sessionQuestions = new Map<string, Question[]>()
    async function createTasklet(sessionId: string): Promise<Tasklet | undefined> {
        const planOutputs = await getPlanOutputs(sessionId)
        
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

        const storedQuestions = sessionQuestions.get(sessionId) ?? []
        for (const question of storedQuestions) {
            const target = planOutputs[question.planOutputIndex]
            if (target) {
                const questionText = `Q: ${question.question}\nA: ${question.answer}`
                target.response = target.response ? `${target.response}\n\n---\n\n${questionText}` : questionText
            }
        }

        sessionQuestions.delete(sessionId)
        
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

        const buildQuestions = storedQuestions.filter(q => q.planOutputIndex >= planOutputs.length)
        if (buildQuestions.length > 0) {
            const buildQuestionText = buildQuestions.map(q => `Q: ${q.question}\nA: ${q.answer}`).join("\n\n---\n\n")
            buildOutput.response = buildOutput.response ? `${buildOutput.response}\n\n---\n\n${buildQuestionText}` : buildQuestionText
        }
        
        const tasklet: Tasklet = {
            id: `tasklet_${sessionId}_${Date.now()}`,
            sessionId,
            planOutputs,
            buildOutput
        }

        await L.debug(`Created tasklet: ${tasklet.id}`, { tasklet })
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

                snapshotLocks.delete(idleSessionId)

                if (sessions.has(idleSessionId)) {
                    const tasklet = await createTasklet(idleSessionId) // TODO: CACHE THIS PLEASE FOR THE LOVE OF GOD // No :)
                    
                    if (!tasklet) {
                        await L.debug("Skipping tasklet creation: no build user message found")
                        return
                    }

                    const output = await $`${tracyPath} --user-name "opencode" --user-email "opencode" --description ${JSON.stringify(tasklet)}`.cwd(repoRoot).text()
                    await L.info(`committed OC changes. tracy.sh: ${output.trim()}`, { tasklet })
                }
            }
        },

        "tool.execute.before": async (input, output) => {
            if (!EDIT_TOOLS.has(input.tool)) return
            await L.info(`tool.execute.before`, { input, output })

            const sessionId = input.sessionID
            if (!sessionId) return

            const path = output.args.filePath as string | undefined
            if (!path) {
                await L.warn(`skill issue: missing pth in tool.execute.before hook`, { input, output })
            }

            if (!snapshotLocks.has(sessionId)) {
                const lockPromise = (async () => {
                    try {
                        const output = await $`${tracyPath}`.cwd(repoRoot).text() // user snapshot
                        await L.info(`created user snapshot for ${path}. tracy.sh: ${output.trim()}`)
                    }
                    catch (e: any) {
                        await L.error(`skill issue: ${e}`)
                    }
                })()

                snapshotLocks.set(sessionId, lockPromise)
            try {
                await $`${tracyPath}`.cwd(repoRoot).quiet() // user snapshot
                await L.info(`created user snapshot for ${path}`)
            }
            catch (e: any) {
                await L.error(`skill issue: ${e}`)
            }
                await snapshotLocks.get(sessionId)
            }
        },

        "tool.execute.after": async (input, output) => {
            if (!EDIT_TOOLS.has(input.tool)) return
            await L.info(`tool.execute.after`, { input, output })

            if (input.tool === "question") {
                const planCount = (await getPlanOutputs(input.sessionID as string)).length
                const isBuildPhase = planCount > 0
                const question: Question = {
                    question: input.args.question,
                    header: input.args.header,
                    options: input.args.options,
                    answer: output.metadata.answers.map((answers: string[]) => answers[0] as string),
                    planOutputIndex: planCount
                }

                const existing = sessionQuestions.get(input.sessionID) ?? []
                sessionQuestions.set(input.sessionID, [...existing, question])
            }
        }
    }
}
