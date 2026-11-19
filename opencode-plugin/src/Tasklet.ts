// Shape of the description JSON tracy.py stores on each AI snapshot commit.
// The VS Code extension parses this (see parseOpenCodeTasklet in
// vscode-extension/src/history/buildHistory.ts), so keep it stable.

export interface Tasklet {
    id: string
    sessionId: string
    title?: string
    planOutputs: PlanOutput[]
    buildOutput: BuildOutput
    questions: Question[]
}

export interface PlanOutput {
    id: string
    model: string
    prompt: string
    response: string
    promptCreatedAt: number
    responseCompletedAt: number | null
}

export interface BuildOutput {
    id: string
    model: string
    prompt: string
    response: string
    promptCreatedAt: number
    responseCompletedAt: number | null
}

export interface Question {
    question: string
    header: string
    options: { label: string; description: string }[]
    answer: string[]
    outputId: string
}
