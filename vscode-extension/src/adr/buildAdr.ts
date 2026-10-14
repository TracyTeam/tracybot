import { History, TaskletMessage, TaskletQuestion } from "../history/types";
import { redactSensitiveText } from "../redact";
import { computeTaskletStatus, describeStatusBasis, findTaskletEntries, TaskletStatus } from "./status";

// Kept free of the 'vscode' module so it can be unit-tested directly.
//
// Builds a MADR-style Architecture Decision Record draft from one tasklet,
// with no LLM involved: everything here is either copied from what Tracybot
// recorded (redacted and shortened) or computed from the code. The parts that
// need judgment (why, trade-offs, consequences) are left as TODOs for a human.

const MAX_EXCERPT_CHARS = 600;
const MAX_PLAN_MESSAGES = 6;
const MAX_TITLE_CHARS = 80;

export interface AdrDraft {
  title: string;
  markdown: string;
  status: TaskletStatus;
}

export interface BuildAdrOptions {
  title: string;
  // "Today", injectable so output is deterministic in tests.
  now?: Date;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function yamlString(value: string): string {
  // JSON strings are valid YAML double-quoted scalars.
  return JSON.stringify(value);
}

function excerpt(text: string): string {
  const redacted = redactSensitiveText(text).replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return redacted.length > MAX_EXCERPT_CHARS ? `${redacted.slice(0, MAX_EXCERPT_CHARS).trimEnd()} …` : redacted;
}

// Quoting keeps the user's own markdown (headings, lists) from restructuring
// the ADR around it.
function quote(speaker: "You" | "AI", text: string): string {
  const lines = `**${speaker}:** ${excerpt(text)}`.split("\n");
  return lines.map(line => (line === "" ? ">" : `> ${line}`)).join("\n");
}

function tableCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

export function defaultTitle(tasklet: { name: string }, agent: string | undefined): string {
  // A request often opens with just a link; that makes a useless title.
  const firstLine = tasklet.name.split("\n").map(l => l.trim()).find(l => l !== "" && !/^https?:\/\/\S+$/.test(l)) ?? "";
  const oneLine = firstLine.replace(/^[#>*\-\s]+/, "").replace(/\s+/g, " ").trim();
  if (oneLine === "") { return `Decision from ${agent ?? "AI"} tasklet`; }
  return oneLine.length > MAX_TITLE_CHARS ? `${oneLine.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…` : oneLine;
}

function messagesOf(messages: TaskletMessage[], stage: "plan" | "build", type: "prompt" | "response"): string[] {
  return messages.filter(m => m.stage === stage && m.type === type && m.message.trim() !== "").map(m => m.message);
}

// buildHistory appends the questions and answers to the response they were
// asked in ("<response>\n\n---\n\nQ: ...\n\nA: ..."). The ADR lists them
// under Considered Options, so repeating them in the context is just noise.
const APPENDED_QUESTIONS = /\n\n---\n\nQ: [\s\S]*$/;

function contextSection(messages: TaskletMessage[], hasStructuredQuestions: boolean): string {
  const text = (message: string) => (hasStructuredQuestions ? message.replace(APPENDED_QUESTIONS, "") : message);

  const parts: string[] = [
    "## Context and Problem Statement",
    "",
    "_Excerpts from the AI conversation this decision came from. Code blocks and local paths are removed and long messages are shortened._",
    "",
  ];

  const planMessages = messages.filter(m => m.stage === "plan" && m.message.trim() !== "");
  if (planMessages.length > 0) {
    parts.push("**Earlier discussion**", "");
    const shown = planMessages.slice(0, MAX_PLAN_MESSAGES);
    parts.push(shown.map(m => quote(m.type === "prompt" ? "You" : "AI", text(m.message))).join("\n>\n"));
    if (planMessages.length > shown.length) {
      parts.push("", `_(${planMessages.length - shown.length} more discussion messages not shown)_`);
    }
    parts.push("");
  }

  const buildPrompt = messagesOf(messages, "build", "prompt")[0];
  if (buildPrompt) {
    parts.push("**Request**", "", quote("You", text(buildPrompt)), "");
  }

  const buildResponse = messagesOf(messages, "build", "response")[0];
  if (buildResponse) {
    parts.push("**What the AI did**", "", quote("AI", text(buildResponse)), "");
  }

  parts.push("_TODO: restate the problem in your own words._");
  return parts.join("\n");
}

function answerLabels(q: TaskletQuestion): string[] {
  return q.answer.map(a => redactSensitiveText(a));
}

function optionsSections(questions: TaskletQuestion[], agent: string | undefined): { options: string; outcome: string } {
  if (questions.length === 0) {
    const why = agent === "opencode"
      ? "No questions were asked during this tasklet."
      : "Not recorded: only OpenCode records the questions the AI asks and the answers.";
    return {
      options: `## Considered Options\n\n_${why}_\n\n_TODO: list the options that were considered._`,
      outcome: "## Decision Outcome\n\n_TODO: state the decision._",
    };
  }

  const optionBlocks = questions.map(q => {
    const heading = redactSensitiveText(q.header.trim() !== "" ? q.header : q.question);
    const chosen = new Set(answerLabels(q));
    const lines = [`### ${heading}`, ""];
    if (q.header.trim() !== "" && q.question.trim() !== "") {
      lines.push(redactSensitiveText(q.question), "");
    }

    const listed = new Set<string>();
    for (const option of q.options) {
      const label = redactSensitiveText(option.label);
      listed.add(label);
      const description = option.description.trim() !== "" ? ` — ${redactSensitiveText(option.description)}` : "";
      lines.push(`- ${label}${description}${chosen.has(label) ? " **(chosen)**" : ""}`);
    }
    for (const answer of chosen) {
      if (!listed.has(answer)) { lines.push(`- ${answer} **(chosen, custom answer)**`); }
    }
    return lines.join("\n");
  });

  const outcomeLines = questions.map(q => {
    const heading = redactSensitiveText(q.header.trim() !== "" ? q.header : q.question);
    const chosen = answerLabels(q);
    return `- ${heading}: ${chosen.length > 0 ? `**${chosen.join(", ")}**` : "_no answer recorded_"}`;
  });

  return {
    options: `## Considered Options\n\n${optionBlocks.join("\n\n")}`,
    outcome: `## Decision Outcome\n\nAs answered during the session:\n\n${outcomeLines.join("\n")}\n\n_TODO: say why this option was chosen._`,
  };
}

export function buildAdr(history: History, key: string, opts: BuildAdrOptions): AdrDraft | undefined {
  const entries = findTaskletEntries(history, key);
  const status = computeTaskletStatus(history, key);
  if (entries.length === 0 || !status) { return undefined; }

  const first = entries[0].tasklet;
  const now = opts.now ?? new Date();
  const title = opts.title.replace(/\s+/g, " ").trim() || defaultTitle(first, first.agentSource);

  const startedAt = first.taskletGeneratedAt ?? first.buildCompletedAt ?? undefined;
  const date = startedAt !== undefined
    ? isoDay(new Date(startedAt))
    : first.originCommitAuthorDate !== undefined ? first.originCommitAuthorDate.slice(0, 10) : isoDay(now);

  const questions = entries.map(e => e.tasklet.questions ?? []).find(q => q.length > 0) ?? [];
  // `tasklet.model` holds the agent's name ("opencode", "claude-code"), not a
  // model; the model that actually answered is recorded on the messages.
  const model = entries.flatMap(e => e.tasklet.messages).find(m => m.model)?.model;
  const { options, outcome } = optionsSections(questions, first.agentSource);

  const frontMatter = [
    "---",
    `status: ${status.status}`,
    `date: ${date}`,
    "decision-makers: TODO",
    `tracybot-tasklet: ${yamlString(key)}`,
    `tracybot-status-basis: ${yamlString(describeStatusBasis(status, isoDay(now)))}`,
    ...(first.agentSource ? [`tracybot-agent: ${first.agentSource}`] : []),
    ...(model ? [`tracybot-model: ${yamlString(model)}`] : []),
    ...(first.sessionId ? [`tracybot-session: ${yamlString(first.sessionId)}`] : []),
    ...(first.originCommitHash ? [`tracybot-commit: ${first.originCommitHash}`] : []),
    "---",
  ];

  const fileRows = entries.map(({ path, tasklet }) =>
    `| ${tableCell(path)} | ${tasklet.lines.length} | ${tasklet.ghostLines.length} |`
  );

  const evidence = [
    "## Evidence (generated by Tracybot)",
    "",
    "Counts are as of when this ADR was created.",
    "",
    "| File | Lines in use | Lines overwritten |",
    "|---|---|---|",
    ...fileRows,
  ].join("\n");

  const body = [
    `# ${title}`,
    "",
    contextSection(first.messages, questions.length > 0),
    "",
    "## Decision Drivers",
    "",
    "_TODO: what forces or constraints shaped the choice?_",
    "",
    options,
    "",
    outcome,
    "",
    "### Consequences",
    "",
    "_TODO: what becomes easier or harder because of this decision?_",
    "",
    "## Pros and Cons of the Options",
    "",
    "_TODO_",
    "",
    evidence,
    "",
    "## More Information",
    "",
    "Drafted by Tracybot from its AI Blame record, with no LLM involved. The `status` and `tracybot-status-basis` lines in the header are computed from who owns the code today; the command \"Tracybot: Refresh ADR Status\" updates only those two lines and never touches the text below.",
  ].join("\n");

  return { title, markdown: `${frontMatter.join("\n")}\n\n${body}\n`, status };
}
