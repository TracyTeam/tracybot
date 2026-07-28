import * as z from "zod";

export const taskletQuestion = z.object({
  question: z.string(),
  header: z.string(),
  options: z.array(z.object({
    label: z.string(),
    description: z.string()
  })),
  answer: z.array(z.string()),
  outputId: z.string()
});

export const taskletMessage = z.object({
  stage: z.enum(["plan", "build"]),
  type: z.enum(["prompt", "response"]),
  model: z.string().optional(),
  message: z.string(),
  questions: z.array(taskletQuestion).optional()
});

export const diffHunkSchema = z.object({
  oldStart: z.number(),
  oldCount: z.number(),
  newStart: z.number(),
  newCount: z.number(),
  isSignificant: z.boolean().optional(),
  bleuScore: z.number().nullable().optional(),
  addedLines: z.array(z.string()).optional(),
  removedLines: z.array(z.string()).optional(),
});

const historySchema = z.object({
  id: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      tasklets: z.array(
        z.object({
          id: z.string(),
          model: z.string(),
          name: z.string(),
          messages: z.array(taskletMessage),
          lines: z.array(z.number()),
          ghostLines: z.array(z.number()),
          originCommitHash: z.string().optional(),
          // Research Mode fields — additive, optional so pre-existing cached
          // History data (built before these fields existed) still type-checks.
          taskletId: z.string().optional(),
          sessionId: z.string().optional(),
          questions: z.array(taskletQuestion).optional(),
          taskletGeneratedAt: z.number().nullable().optional(),
          buildCompletedAt: z.number().nullable().optional(),
          originCommitAuthorDate: z.string().optional(),
          originCommitCommitterDate: z.string().optional(),
          diffHunks: z.array(diffHunkSchema).optional(),
          agentSource: z.enum(["opencode", "claude-code"]).optional(),
        })
      )
    })
  )
});
export type History = z.infer<typeof historySchema>;
export type TaskletMessage = z.infer<typeof taskletMessage>
export type TaskletQuestion = z.infer<typeof taskletQuestion>

export interface CommitInfo {
  hash: string;
  authorEmail: string;
  authorName: string;
  message: string;
  description: string;
  parentHash: string | null;  // use this to traverse the hidden chain (null for initial commit)
  treeHash: string;           // use this to compute diffs between commits
  authorDate: string;         // ISO 8601, strict (git %aI)
  committerDate: string;      // ISO 8601, strict (git %cI)
}

export interface Change {
  filePath: string;
  lines: number[];
  ghostLines: number[];
  model: string;
  name: string;
  tasklet_messages: TaskletMessage[];
  snapshotHash: string;
  originCommitHash?: string;
  // Research Mode fields — see historySchema's tasklet object for field meanings
  taskletId?: string;
  sessionId?: string;
  questions?: TaskletQuestion[];
  taskletGeneratedAt?: number | null;
  buildCompletedAt?: number | null;
  originCommitAuthorDate?: string;
  originCommitCommitterDate?: string;
  diffHunks?: DiffHunk[];
  agentSource?: "opencode" | "claude-code";
}

// Extends the base Tasklet type from History with runtime-only UI state
export type TaskletUI = History['files'][number]['tasklets'][number] & { selected: boolean };

export type LineMap = Map<string, Map<number, TaskletUI>>;

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  isSignificant?: boolean;
  bleuScore?: number | null; // raw BLEU similarity; null when BLEU doesn't apply (pure add/delete)
  addedLines?: string[];     // actual code content added by this hunk
  removedLines?: string[];   // actual code content removed by this hunk
}
