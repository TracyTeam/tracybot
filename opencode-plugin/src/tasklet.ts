export interface Tasklet {
    id: string
    sessionId: string
    planOutputs?: PlanOutput[]
    buildOutput: BuildOutput | null

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