export interface Tasklet {
    id: string
    sessionId: string
    title?: string
    planOutputs: PlanOutput[]
    buildOutput: BuildOutput
}

export interface PlanOutput {
    id: string
    prompt: string
    response: string
}

export interface BuildOutput {
    id: string
    prompt: string
    response: string
}
