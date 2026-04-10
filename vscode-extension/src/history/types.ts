import * as z from "zod";

export const taskletMessage = z.object({
  stage: z.enum(["plan", "build"]),
  type: z.enum(["prompt", "response"]),
  message: z.string(),
});

const historySchema = z.object({
  id: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      tasklets: z.array(
        z.object({
          model: z.string(),
          name: z.string(),
          messages: z.array(taskletMessage),
          lines: z.array(z.number())
        })
      )
    })
  )
});
export type History = z.infer<typeof historySchema>;
export type TaskletMessage = z.infer<typeof taskletMessage>

export interface CommitInfo {
  hash: string;
  authorEmail: string;
  authorName: string;
  message: string;
  description: string;
  parentHash: string | null;  // use this to traverse the hidden chain (null for initial commit)
  treeHash: string;           // use this to compute diffs between commits
}

export interface Change {
  filePath: string;
  lines: number[];
  model: string;
  tasklet_messages: TaskletMessage[];
  snapshotHash: string;
}

export type FileLineDelta = {
  consumed: { at: number; oldCount: number }[];
  shifts: { at: number; delta: number; oldCount: number }[];
};

// Extends the base Tasklet type from History with runtime-only UI state
export type TaskletUI = History['files'][number]['tasklets'][number] & { selected: boolean };

export type LineMap = Map<string, Map<number, TaskletUI>>;

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}
