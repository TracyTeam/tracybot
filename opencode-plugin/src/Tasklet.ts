export interface Tasklet {
    id: string
    sessionId: string
    planOutputs: PlanOutput[]
    buildOutput: BuildOutput
    questions: Question[]
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
    question: string
    header: string
    options: {label: string; description: string}[]
    answer: string
    outputId: string
}