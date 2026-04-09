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
    questions?: Question[]
    
}

export interface BuildOutput {
    id: string
    prompt: string
    response: string
}

export interface Question {
    question: string
    header: string
    options: {label: string; description: string}[]
    answer: string
    planOutputIndex: number
}