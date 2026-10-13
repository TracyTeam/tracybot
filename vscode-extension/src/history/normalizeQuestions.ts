import { TaskletQuestion } from "./types";

// Kept free of the 'vscode' module so it can be unit-tested directly.
//
// Tasklets are parsed from JSON written by the agent plugins, and old plugin
// versions wrote a question's `answer` as a plain string (and could leave
// fields out). A single such record used to make the whole history build
// throw ("q.answer.join is not a function"), so AI Blame failed for the entire
// repository. Everything downstream (the AI Blame messages, Research Mode, ADR
// drafts) expects the documented shape, so it is restored once, here.
export function normalizeQuestions(raw: unknown): TaskletQuestion[] {
  if (!Array.isArray(raw)) { return []; }

  return raw
    .filter((q): q is Record<string, unknown> => q !== null && typeof q === "object")
    .map(q => ({
      question: typeof q.question === "string" ? q.question : "",
      header: typeof q.header === "string" ? q.header : "",
      options: Array.isArray(q.options)
        ? q.options
            .filter((o): o is Record<string, unknown> => o !== null && typeof o === "object")
            .map(o => ({ label: String(o.label ?? ""), description: String(o.description ?? "") }))
        : [],
      answer: Array.isArray(q.answer) ? q.answer.map(String) : q.answer === null || q.answer === undefined ? [] : [String(q.answer)],
      outputId: typeof q.outputId === "string" ? q.outputId : "",
    }));
}
