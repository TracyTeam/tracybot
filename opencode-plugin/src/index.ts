import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import type { Part } from "@opencode-ai/sdk"
import type { Tasklet, PlanOutput, BuildOutput, Question } from "./Tasklet"
import path from "path"
import { Logger } from "./Logger"

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
    const pendingQuestionsIndices = new Map<string, number[]>()

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
        const finalPlanCount = planOutputs.length
        for (const question of storedQuestions) {
            const questionText = JSON.stringify(question)
            
            if (question.planOutputIndex >= finalPlanCount) {
                continue
            }
            
            const target = planOutputs[question.planOutputIndex]
            if (target) {
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
            const buildQuestionText = buildQuestions.map(q => JSON.stringify(q)).join("\n\n---\n\n")
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
            if (!EDIT_TOOLS.has(input.tool) && input.tool !== "question") return
            await L.info(`tool.execute.before`, { input, output })

            const sessionId = input.sessionID
            if (!sessionId) return

            if (input.tool === "question") {
                const callID = input.callID
                if (callID) {
                    const planOutputIndex = (await getPlanOutputs(sessionId)).length
                    pendingQuestionsIndices.set(`${sessionId}:${callID}:`, planOutputIndex)
                    await L.debug(`Captured planOutputIndex ${planOutputIndex} for question in before hook`)
                }
            }

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
            if (!EDIT_TOOLS.has(input.tool) && input.tool !== "question") return
            await L.info(`tool.execute.after`, { input, output })
            
            if (input.tool === "question") {
                const questionsArg = input.args.questions as Array<{
                    question: string
                    header: string
                    options: Array<{label: string; description: string}>
                }>

                let planOutputIndex = pendingQuestionsIndices.get(`${input.sessionID}:${input.callID}`)
                if (planOutputIndex === undefined) {
                    planOutputIndex = (await getPlanOutputs(input.sessionID as string)).length
                    await L.warn(`Question planOutputIndex is not found in the pending map, using fallback: ${planOutputIndex}`)
                } else {
                    pendingQuestionsIndices.delete(`${input.sessionID}:${input.callID}`)
                }

                for (let i = 0; i < questionsArg.length; i++) {
                    const q = questionsArg[i]
                    if (q) {
                        const question: Question = {
                            question: q.question,
                            header: q.header,
                            options: q.options,
                            answer: output.metadata.answers[i]?.[0] as string ?? "",
                            planOutputIndex
                        }

                        const existing = sessionQuestions.get(input.sessionID) ?? []
                        sessionQuestions.set(input.sessionID, [...existing, question])
                    } else {
                        await L.error("Question not found when tool was called")
                    }
                }

            }
        }
    }
}
