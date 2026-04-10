# Fix: Question planOutputIndex Implementation

## Problem
`planOutputIndex` is captured in `tool.execute.after` (when user answers), not when question is created (in `tool.execute.before`). This causes questions to be associated with wrong plan outputs.

## Solution

### Change 1: Add pending questions map (after line 97)

```typescript
const pendingQuestionIndices = new Map<string, number>()
```

### Change 2: In `tool.execute.before` (around lines 206-240), add handling for question tool

```typescript
"tool.execute.before": async (input, output) => {
    if (!EDIT_TOOLS.has(input.tool) && input.tool !== "question") return
    await L.info(`tool.execute.before`, { input, output })

    // NEW: Capture planOutputIndex for question tool BEFORE showing to user
    if (input.tool === "question") {
        const sessionId = input.sessionID
        const callId = input.callID
        if (sessionId && callId) {
            const planOutputIndex = (await getPlanOutputs(sessionId)).length
            pendingQuestionIndices.set(`${sessionId}:${callId}`, planOutputIndex)
            await L.debug(`Captured planOutputIndex ${planOutputIndex} for question in before hook`)
        }
    }

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
```

### Change 3: In `tool.execute.after` (around lines 241-272), retrieve planOutputIndex from pending map

```typescript
"tool.execute.after": async (input, output) => {
    if (!EDIT_TOOLS.has(input.tool) && input.tool !== "question") return
    await L.info(`tool.execute.after`, { input, output })
    
    if (input.tool === "question") {
        const questionsArg = input.args.questions as Array<{
            question: string
            header: string
            options: Array<{label: string; description: string}>
        }>

        // NEW: Retrieve planOutputIndex from pending map instead of recalculating
        const sessionId = input.sessionID as string
        const callId = input.callID as string
        let planOutputIndex = pendingQuestionIndices.get(`${sessionId}:${callId}`)
        
        // Fallback: if not found in pending map, use current count
        if (planOutputIndex === undefined) {
            planOutputIndex = (await getPlanOutputs(sessionId)).length
            await L.warn(`Question planOutputIndex not found in pending map, using fallback: ${planOutputIndex}`)
        } else {
            // Delete from pending map after retrieving
            pendingQuestionIndices.delete(`${sessionId}:${callId}`)
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

                const existing = sessionQuestions.get(sessionId) ?? []
                sessionQuestions.set(sessionId, [...existing, question])
            } else {
                await L.error("Question not found when tool was called")
            }
        }

    }
}
```

### Summary of Changes

1. Add `pendingQuestionIndices` map to store indices at question creation time
2. In `tool.execute.before`: capture and store `planOutputIndex` when question is shown
3. In `tool.execute.after`: retrieve stored index instead of recalculating
4. Delete from pending map after retrieving to prevent memory leaks
5. Add fallback for edge cases where pending index is not found