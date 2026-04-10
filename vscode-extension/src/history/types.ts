import * as z from "zod";

const historySchema = z.object({
  id: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      tasklets: z.array(
        z.object({
          model: z.string(),
          name: z.string(),
          prompt: z.string(),
          lines: z.array(z.number())
        })
      )
    })
  )
});
export type History = z.infer<typeof historySchema>;

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
  prompt: string;
}