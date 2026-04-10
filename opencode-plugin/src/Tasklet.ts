export interface Tasklet {
    id: string
    sessionId: string
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

export interface Question {
    questions: { question: string; header: string; options: {label: string; description: string}[] }[]
    answers: string[]
    planOutputIndex: number
}