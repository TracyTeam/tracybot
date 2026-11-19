import { History } from "../history/types";

// Kept free of the 'vscode' module so it can be unit-tested directly.

type TaskletEntry = History["files"][number]["tasklets"][number];

export type AdrStatus = "proposed" | "accepted" | "superseded";

export interface Successor {
  key: string;
  name: string;
}

export interface TaskletStatus {
  status: AdrStatus;
  // Summed over every file the tasklet touched.
  liveLines: number;
  overwrittenLines: number;
  committed: boolean;
  // Later tasklets that now own the lines this one wrote. Empty when the lines
  // were removed or rewritten by hand, which leaves no AI tasklet to name.
  supersededBy: Successor[];
}

// A snapshot that touches several files gets one entry per file; taskletId is
// the stable id that ties them together (and is the same id Research Mode
// reports). Older cached History has no taskletId, so fall back to the
// snapshot hash `id`.
export function taskletKey(tasklet: Pick<TaskletEntry, "id" | "taskletId">): string {
  return tasklet.taskletId ?? tasklet.id;
}

export function findTaskletEntries(history: History, key: string): { path: string; tasklet: TaskletEntry }[] {
  const found: { path: string; tasklet: TaskletEntry }[] = [];
  for (const file of history.files) {
    for (const tasklet of file.tasklets) {
      if (taskletKey(tasklet) === key) {
        found.push({ path: file.path, tasklet });
      }
    }
  }
  return found;
}

// Status is derived from who owns the code today, not from anything the
// author typed, so it can be recomputed whenever the code changes:
//   superseded: none of the tasklet's lines are in use any more
//   proposed:   its code is still in use but hasn't been committed yet
//   accepted:   its code is in use and committed
// A tasklet that was only partly overwritten is still accepted; the line
// counts say how much of it survives.
export function computeTaskletStatus(history: History, key: string): TaskletStatus | undefined {
  const entries = findTaskletEntries(history, key);
  if (entries.length === 0) { return undefined; }

  let liveLines = 0;
  let overwrittenLines = 0;
  for (const { tasklet } of entries) {
    liveLines += tasklet.lines.length;
    overwrittenLines += tasklet.ghostLines.length;
  }

  const committed = entries.some(({ tasklet }) => tasklet.originCommitHash !== undefined);
  const supersededBy = liveLines === 0 ? findSuccessors(history, key, entries) : [];

  let status: AdrStatus = "accepted";
  if (liveLines === 0 && overwrittenLines > 0) {
    status = "superseded";
  } else if (!committed) {
    status = "proposed";
  }

  return { status, liveLines, overwrittenLines, committed, supersededBy };
}

// The owner of a line is whichever tasklet lists it in its live `lines`; ghost
// lines use the same (current-file) numbering, so an overwritten line's owner
// is simply the tasklet that has that line number live today.
function findSuccessors(history: History, key: string, entries: { path: string; tasklet: TaskletEntry }[]): Successor[] {
  const successors = new Map<string, Successor>();

  for (const { path, tasklet } of entries) {
    const file = history.files.find(f => f.path === path);
    if (!file) { continue; }

    const ownerOfLine = new Map<number, TaskletEntry>();
    for (const other of file.tasklets) {
      for (const line of other.lines) { ownerOfLine.set(line, other); }
    }

    for (const line of tasklet.ghostLines) {
      const owner = ownerOfLine.get(line);
      if (!owner) { continue; }
      const ownerKey = taskletKey(owner);
      if (ownerKey !== key && !successors.has(ownerKey)) {
        successors.set(ownerKey, { key: ownerKey, name: owner.name });
      }
    }
  }

  return Array.from(successors.values());
}

// One line saying what the status is based on, written into the ADR next to
// the status itself so a reader knows it is computed and from what.
export function describeStatusBasis(s: TaskletStatus, on: string): string {
  const total = s.liveLines + s.overwrittenLines;
  const usage = `${s.liveLines} of ${total} lines still in use`;

  let detail = usage;
  if (s.status === "superseded" && s.supersededBy.length > 0) {
    detail += `; overwritten by ${s.supersededBy.map(x => `"${x.name}"`).join(", ")}`;
  } else if (s.status === "superseded") {
    detail += "; overwritten by later changes";
  } else if (s.status === "proposed") {
    detail += "; not committed yet";
  }
  return `${detail} (checked ${on})`;
}
