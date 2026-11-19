// Tracybot plugin for OpenCode 2.x.
//
// OpenCode 2.x only loads plugins whose module default-exports
// `{ id, setup(ctx) }` (or `{ id, effect }`). The 1.x shape, a named export of
// an `async (input) => hooks` function, is rejected at load time with
// "Plugin must export a default definition with an id and an effect or setup
// function", which left every OpenCode edit unattributed.
import type { Plugin } from "@opencode/plugin"
import type { Tasklet, PlanOutput, BuildOutput, Question } from "./Tasklet"
import path from "path"
import fs from "fs"
import { Logger } from "./Logger"

// `.git` is a file ("gitdir: ..."), not a directory, in a linked worktree or a
// submodule, so `<repo>/.git/tracybot/...` can't exist there. Tracybot keeps
// its config in the *common* git dir (where init.py writes it and where the
// git hooks live), which for a linked worktree is found through the
// `commondir` pointer inside the worktree's own git dir.
function resolveGitDir(repoRoot: string): string {
    const dotGit = path.join(repoRoot, ".git")
    try {
        if (!fs.statSync(dotGit).isFile()) return dotGit
        const target = fs.readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]
        if (!target) return dotGit

        const gitDir = path.resolve(repoRoot, target.trim())
        const commonDirFile = path.join(gitDir, "commondir")
        if (fs.existsSync(commonDirFile)) {
            return path.resolve(gitDir, fs.readFileSync(commonDirFile, "utf8").trim())
        }
        return gitDir
    } catch {
        return dotGit
    }
}

type Context = Plugin.Context
type SessionMessages = Awaited<ReturnType<Context["session"]["context"]>>
type SessionMessage = SessionMessages[number]
type UserMessage = Extract<SessionMessage, { type: "user" }>
type AssistantMessage = Extract<SessionMessage, { type: "assistant" }>

// Tools that change files. A user snapshot is taken before the first of these
// in a turn so pending human edits aren't attributed to the agent.
const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit", "apply_patch", "applypatch", "shell", "bash"])
const BUILD_AGENT = "build"

// One user prompt and the assistant messages that answered it. OpenCode 2.x
// no longer stores the agent or model on user messages, so both are read
// from the answering assistant messages.
interface Turn {
    user: UserMessage
    assistants: AssistantMessage[]
    agent: string | undefined
}

function toTurns(messages: SessionMessages): Turn[] {
    const turns: Turn[] = []
    let currentAgent: string | undefined
    for (const message of messages) {
        if (message.type === "agent-switched") {
            currentAgent = message.agent
        } else if (message.type === "user") {
            turns.push({ user: message, assistants: [], agent: currentAgent })
        } else if (message.type === "assistant") {
            const turn = turns[turns.length - 1]
            if (!turn) continue
            if (turn.assistants.length === 0) turn.agent = message.agent
            turn.assistants.push(message)
            currentAgent = message.agent
        }
    }
    return turns
}

const isBuild = (turn: Turn) => turn.agent === BUILD_AGENT

const assistantText = (assistants: AssistantMessage[]): string =>
    assistants
        .map(message => message.content.flatMap(part => part.type === "text" && part.text ? [part.text] : []).join("\n\n---\n\n"))
        .filter(text => text.trim().length > 0)
        .join("\n\n---\n\n")

const turnModel = (turn: Turn): string => {
    const model = turn.assistants[turn.assistants.length - 1]?.model
    return model ? `${model.providerID}/${model.id}` : "unknown"
}

const turnOutput = (turn: Turn, id: string): PlanOutput & BuildOutput => ({
    id,
    model: turnModel(turn),
    prompt: turn.user.text,
    response: assistantText(turn.assistants),
    promptCreatedAt: turn.user.time.created,
    responseCompletedAt: turn.assistants[turn.assistants.length - 1]?.time.completed ?? null,
})

// Plan turns since the build turn before `index`, which are the turns a
// tasklet ending at `index` carries as its planOutputs.
function planTurnsBefore(turns: Turn[], index: number): Turn[] {
    let prevBuild = -1
    for (let i = index - 1; i >= 0; i--) {
        if (isBuild(turns[i]!)) {
            prevBuild = i
            break
        }
    }
    return turns.slice(prevBuild + 1, index).filter(turn => !isBuild(turn))
}

const tracybot: Plugin.Plugin = {
    id: "tracybot",
    setup: async (ctx) => {
        const L = new Logger()
        const directory = ctx.location.directory

        const repoRootResult = await Bun.$`git rev-parse --show-toplevel`.cwd(directory).quiet().nothrow()
        if (repoRootResult.exitCode !== 0) {
            await L.error("Not a git repo", { directory })
            return
        }
        const repoRoot = repoRootResult.stdout.toString("utf8").trim()

        async function resolveTracyPath(): Promise<string | undefined> {
            if (process.env.TRACY_SNAPSHOT_SCRIPT) {
                return path.resolve(repoRoot, process.env.TRACY_SNAPSHOT_SCRIPT)
            }

            const configFile = Bun.file(path.join(resolveGitDir(repoRoot), "tracybot", "config"))
            if (!(await configFile.exists())) return

            // Try UTF-8 first; fall back to windows-1252 for config files written
            // before the utf-8 fix was applied to init.py (Windows default encoding).
            const bytes = await configFile.bytes()
            let text: string
            try {
                text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
            } catch {
                text = new TextDecoder("windows-1252").decode(bytes)
            }

            for (const line of text.replace(/^﻿/, "").split("\n")) {
                const trimmedLine = line.trim()
                // Skip empty lines and comments (matches Python hook parsing)
                if (!trimmedLine || trimmedLine.startsWith("#")) continue
                const eqIndex = trimmedLine.indexOf("=")
                if (eqIndex === -1) continue
                const key = trimmedLine.substring(0, eqIndex).trim()
                const value = trimmedLine.substring(eqIndex + 1).trim()
                if (key) process.env[key] = value.replace(/\r/g, "")
            }

            if (!process.env.TRACY_SNAPSHOT_SCRIPT) return
            return path.resolve(repoRoot, process.env.TRACY_SNAPSHOT_SCRIPT)
        }

        const tracyPath = await resolveTracyPath()
        if (!tracyPath || !(await Bun.file(tracyPath).exists())) {
            await L.error("tracy.py not found", { repoRoot })
            return
        }

        let pythonCmd: string
        if ((await Bun.$`python3 --version`.quiet().nothrow()).exitCode === 0) {
            pythonCmd = "python3"
        } else if ((await Bun.$`python --version`.quiet().nothrow()).exitCode === 0) {
            pythonCmd = "python"
        } else {
            await L.error("Neither python nor python3 is available")
            return
        }

        await L.info("Plugin initialized", { repoRoot, tracyPath, pythonCmd, opencode: ctx.app.version })

        const snapshotLocks = new Map<string, Promise<void>>()
        const toolCounter = new Map<string, number>()
        const lastBuildId = new Map<string, string>()
        const sessionQuestions = new Map<string, Question[]>()
        const idleLocks = new Map<string, Promise<void>>()

        async function createTasklet(sessionId: string): Promise<Tasklet | undefined> {
            const turns = toTurns(await ctx.session.context({ sessionID: sessionId }))

            let buildIndex = -1
            for (let i = turns.length - 1; i >= 0; i--) {
                if (isBuild(turns[i]!)) {
                    buildIndex = i
                    break
                }
            }
            const buildTurn = turns[buildIndex]
            if (!buildTurn) {
                await L.debug("No build turn found, skipping tasklet creation", { sessionId })
                return
            }
            if (buildTurn.user.id === lastBuildId.get(sessionId)) {
                await L.debug(`Build ${buildTurn.user.id} already processed, skipping`)
                return
            }

            const planOutputs = planTurnsBefore(turns, buildIndex).map((turn, idx) => turnOutput(turn, `plan_${idx}`))
            const session = await ctx.session.get({ sessionID: sessionId }).catch(() => undefined)

            const tasklet: Tasklet = {
                id: `tasklet_${sessionId}_${Date.now()}`,
                sessionId,
                title: session?.title?.trim(),
                planOutputs,
                buildOutput: turnOutput(buildTurn, `build_${planOutputs.length}`),
                questions: sessionQuestions.get(sessionId) ?? [],
            }

            lastBuildId.set(sessionId, buildTurn.user.id)
            sessionQuestions.delete(sessionId)
            return tasklet
        }

        async function onIdle(sessionId: string) {
            snapshotLocks.delete(sessionId)

            const toolCount = toolCounter.get(sessionId) ?? 0
            if (toolCount === 0) return

            const tasklet = await createTasklet(sessionId)
            if (!tasklet) return

            const result = await Bun.$`${pythonCmd} ${tracyPath} --user-name opencode --user-email opencode --description ${JSON.stringify(tasklet)} --session-id ${tasklet.sessionId}`
                .cwd(repoRoot)
                .quiet()
                .nothrow()
            if (result.exitCode !== 0) {
                await L.error("tracy.py failed to record the AI snapshot", {
                    exitCode: result.exitCode,
                    stderr: result.stderr.toString("utf8"),
                })
                return
            }
            toolCounter.set(sessionId, 0)
            await L.info("Recorded OpenCode snapshot", { taskletId: tasklet.id, toolCount })
        }

        // Runs when a session finishes its model work, just before it goes idle.
        // (`ctx.event.subscribe` never delivers session.status/session.idle to
        // plugins in 2.3.2.) The work is queued rather than awaited: a hook that
        // throws fails the session's execution, and the session shouldn't wait
        // on tracy.py. The per-session chain keeps snapshots in order.
        await ctx.session.hook("experimental.idle", (event) => {
            const sessionId = event.sessionID
            const next = (idleLocks.get(sessionId) ?? Promise.resolve())
                .then(() => onIdle(sessionId))
                .catch(error => L.error("Failed to record snapshot on idle", { sessionId, error: String(error) }))
            idleLocks.set(sessionId, next)
        })

        await ctx.tool.hook("execute.before", async (event) => {
            const sessionId = event.sessionID
            toolCounter.set(sessionId, (toolCounter.get(sessionId) ?? 0) + 1)

            if (!EDIT_TOOLS.has(event.tool)) return

            // Snapshot the human's pending changes once per turn, before the agent's first edit.
            if (!snapshotLocks.has(sessionId)) {
                snapshotLocks.set(sessionId, (async () => {
                    const result = await Bun.$`${pythonCmd} ${tracyPath}`.cwd(repoRoot).quiet().nothrow()
                    if (result.exitCode !== 0) {
                        await L.error("tracy.py failed to record the user snapshot", {
                            exitCode: result.exitCode,
                            stderr: result.stderr.toString("utf8"),
                        })
                        return
                    }
                    await L.info("Created user snapshot", { tool: event.tool })
                })())
            }
            await snapshotLocks.get(sessionId)
        })

        await ctx.tool.hook("execute.after", async (event) => {
            if (event.tool !== "question" || event.status !== "completed") return

            const input = event.input as { questions?: Array<{ question: string; header: string; options: Array<{ label: string; description: string }> }> }
            const questions = input.questions ?? []
            const metadata = event.result.metadata as { answers?: string[][] } | undefined
            const output = event.result.output as { answers?: string[][] } | undefined
            const answers = metadata?.answers ?? output?.answers ?? []

            // The question belongs to the session's latest turn. Its output id
            // matches the one createTasklet will give that turn.
            const turns = toTurns(await ctx.session.context({ sessionID: event.sessionID }))
            const index = turns.length - 1
            const planCount = index >= 0 ? planTurnsBefore(turns, index).length : 0
            const outputId = event.agent === BUILD_AGENT ? `build_${planCount}` : `plan_${planCount}`

            const stored = questions.map((q, i): Question => ({
                question: q.question,
                header: q.header,
                options: q.options.map(option => ({ label: option.label, description: option.description })),
                answer: answers[i] ?? [],
                outputId,
            }))
            sessionQuestions.set(event.sessionID, [...(sessionQuestions.get(event.sessionID) ?? []), ...stored])
        })
    },
}

export default tracybot
