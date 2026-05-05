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
    await L.info("DEBUG directory", { directory })
    const repoRoot = await getRepoRoot()
    if (!repoRoot) {
        await L.error("Not a git repo")
        return {} // No-op
    }

    async function getPlanOutputs(sessionId: string): Promise<PlanOutput[]> {
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
        if (process.env.TRACY_SNAPSHOT_SCRIPT) {
            return path.resolve(repoRoot, process.env.TRACY_SNAPSHOT_SCRIPT)
        }

        const configPath = path.join(repoRoot, ".git", "tracybot", "config")
        const configFile = Bun.file(configPath)

        if (!(await configFile.exists())) return

        // cannot use dotenv, so enjoy this handrolled env parsing
        const text = await configFile.text();
        // Remove UTF-8 BOM (safeguard for cross-platform edge cases)
        const cleanedText = text.replace(/^\uFEFF/, '');

        for (const line of cleanedText.split("\n")) {
            const trimmedLine = line.trim();
            // Skip empty lines and comments (matches Python hook parsing)
            if (!trimmedLine || trimmedLine.startsWith("#")) continue;

            // Split on FIRST = only (avoids issues with edge cases)
            const eqIndex = trimmedLine.indexOf("=");
            if (eqIndex === -1) continue;

            const key = trimmedLine.substring(0, eqIndex).trim();
            const value = trimmedLine.substring(eqIndex + 1).trim();

            if (key && value !== undefined) {
                process.env[key] = value.replace(/\r/g, '');
            }
        }

        if (!process.env.TRACY_SNAPSHOT_SCRIPT) return
        return path.resolve(repoRoot, process.env.TRACY_SNAPSHOT_SCRIPT)
    }

    const tracyPath = await resolveTracyPath(repoRoot)
    const isInstalled = tracyPath ? await Bun.file(tracyPath).exists() : false

    if (!isInstalled || !tracyPath) {
        await L.error("tracy.py not found")
        return {} // No-op
    }

    await L.info("Plugin initialized", { repoRoot, tracyPath })

    let pythonCmd;
    if ((await $`python3 --version`.quiet()).exitCode === 0) {
        pythonCmd = 'python3'
        await L.info("Detected python command: python3")
    } else {
        if ((await $`python --version`.quiet()).exitCode === 0) {
            pythonCmd = 'python'
            await L.info("Detected python command: python")
        } else {
            await L.error("Neither python nor python3 is available")
            return {}
        }
    }

    let sessions = new Set<string>()
    const snapshotLocks = new Map<string, Promise<void>>()
    const taskletToolCounter = new Map<string, number>()

    const sessionQuestions = new Map<string, Question[]>()
    const pendingQuestionsIndices = new Map<string, string[]>()

    async function createTasklet(sessionId: string): Promise<Tasklet | undefined> {
        const planOutputs = await getPlanOutputs(sessionId)

        const response = await client.session.messages({
            path: { id: sessionId }
        })


        const title = (await client.session.get({ path: { id: sessionId } }))
            .data?.title.trim()

        const allMessages = response.data ?? []

        const getTextFromParts = (parts: Part[] | undefined): string => {
            if (!parts) return ""
            return parts
                .flatMap(part => part.type === "text" && part.text ? [part.text] : [])
                .join("\n\n---\n\n")
        }

        const storedQuestions = sessionQuestions.get(sessionId) ?? []
        const finalPlanCount = planOutputs.length
        await L.info(`Processing ${storedQuestions.length} stored questions, finalPlanCount: ${finalPlanCount}`, { storedQuestions })


        const buildUserMsg = [...allMessages].reverse().find(
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
            title,
            planOutputs,
            buildOutput,
            questions: storedQuestions
        }

        await L.debug(`Created tasklet: ${tasklet.id}`, { tasklet })
        sessionQuestions.delete(sessionId)
        return tasklet
    }

    return {
        event: async ({ event }) => {
            if (event.type === "session.created") {
                const sessionId = event.properties.info.id
                if (sessionId) {
                    sessions.add(sessionId)
                    taskletToolCounter.set(sessionId, 0)
                }
                return
            }

            if (event.type === "session.deleted") {
                const sessionId = event.properties.info.id
                if (sessionId) {
                    sessions.delete(sessionId)
                }
                return
            }

            if (event.type === "session.idle") {
                const idleSessionId = event.properties.sessionID

                snapshotLocks.delete(idleSessionId)

                if (sessions.has(idleSessionId)) {

                    const toolCount = taskletToolCounter.get(idleSessionId) ?? 0
                    await L.info(`Tool count for session ${idleSessionId}: ${toolCount}`)

                    if (toolCount === 0) {
                        await L.info("No tool activity → skipping tracy.py")
                        return
                    }

                    const tasklet = await createTasklet(idleSessionId) // TODO: CACHE THIS PLEASE FOR THE LOVE OF GOD // No :)

                    if (!tasklet) {
                        await L.debug("Skipping tasklet creation: no build user message found")
                        return
                    }

                    const output = await $`${pythonCmd} ${tracyPath} --user-name "opencode" --user-email "opencode" --description ${JSON.stringify(tasklet)} --session-id "${tasklet.sessionId}" `.cwd(repoRoot).text()
                    await L.info(`committed OC changes. tracy.py: ${output.trim()}`, { tasklet })

                    taskletToolCounter.set(idleSessionId, 0)
                }
                return
            }
        },

        "tool.execute.before": async (input, output) => {

            const sessionId = input.sessionID
            if (sessionId) {
                const current = taskletToolCounter.get(sessionId) ?? 0
                taskletToolCounter.set(sessionId, current + 1)
            }

            // Edit tool -> create user snapshot before the file is edited
            if (EDIT_TOOLS.has(input.tool)) {
                const sessionId = input.sessionID
                if (!sessionId) return

                const path = output.args.filePath as string | undefined
                if (!path) {
                    await L.warn(`skill issue: missing path in tool.execute.before hook`, { input, output })
                }

                if (!snapshotLocks.has(sessionId)) {
                    const lockPromise = (async () => {
                        const result = await $`${pythonCmd} "${tracyPath}"`
                            .cwd(repoRoot)
                            .quiet()

                        if (result.exitCode !== 0) {
                            await L.error("Python failed", {
                                stdout: result.stdout.toString(),
                                stderr: result.stderr.toString(),
                                exitCode: result.exitCode
                            })
                            return
                        }

                        await L.info(
                            `created user snapshot for ${path}. tracy.py: ${result.stdout.toString().trim()}`
                        )
                    })()

                    snapshotLocks.set(sessionId, lockPromise)
                }

                await snapshotLocks.get(sessionId)
            }
            // Question tool -> save the question
            else if (input.tool == "question") {
                const sessionId = input.sessionID

                const callID = input.callID
                if (!sessionId || !callID) return

                const messages = await client.session.messages({ path: { id: sessionId } })
                const planCount = messages.data?.filter(m => m.info.role === "user" && m.info.agent !== "build").length ?? 0
                const hasBuild = messages.data?.some(m => m.info.role === "user" && m.info.agent === "build")

                const outputId = hasBuild ? `build_${planCount}` : `plan_${planCount === 0 ? 0 : planCount - 1}`

                const existing = pendingQuestionsIndices.get(`${sessionId}:${callID}`) ?? []
                pendingQuestionsIndices.set(`${sessionId}:${callID}`, [...existing, outputId])
                await L.debug(`Pending questions stored: ${sessionId}:${callID} -> ${outputId}`)
            }
        },


        "tool.execute.after": async (input, output) => {
            if (input.tool === "question") {
                const questionsArg = input.args.questions as Array<{
                    question: string
                    header: string
                    options: Array<{ label: string; description: string }>
                }>

                const outputIds = pendingQuestionsIndices.get(`${input.sessionID}:${input.callID}`) ?? []
                let outputId = outputIds.shift()

                if (outputId === undefined) {
                    const messages = await client.session.messages({ path: { id: input.sessionID } })
                    const planCount = messages.data?.filter(m => m.info.role === "user" && m.info.agent !== "build").length ?? 0
                    const hasBuild = messages.data?.some(m => m.info.role === "user" && m.info.agent === "build")

                    outputId = hasBuild ? `build_${planCount}` : `plan_${planCount === 0 ? 0 : planCount - 1}`

                    await L.warn(`Question planOutputIndex is not found in the pending map, using fallback: ${outputId}`)
                } else {
                    pendingQuestionsIndices.delete(`${input.sessionID}:${input.callID}`)
                    await L.info(`Retrieved question planOutputIndex: ${outputId} for ${input.sessionID}:${input.callID}`)
                }

                for (let i = 0; i < questionsArg.length; i++) {
                    const q = questionsArg[i]
                    if (q) {
                        const question: Question = {
                            question: q.question,
                            header: q.header,
                            options: q.options,
                            answer: output.metadata.answers[i] ?? [],
                            outputId
                        }

                        const existing = sessionQuestions.get(input.sessionID) ?? []
                        sessionQuestions.set(input.sessionID, [...existing, question])
                    } else {
                        await L.error("Question not found when tool was called")
                    }
                }

            } else {
                return
            }
        }
    }
}
