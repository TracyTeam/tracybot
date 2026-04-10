// This function simulates fetching data from git and returning the results

import * as z from "zod";

const mockDataSchema = z.object({
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

export type MockData = z.infer<typeof mockDataSchema>;

export function getMockData(): MockData {
  return {
    id: "mock-id",
    files: [
      {
        path: "example.ts",
        tasklets: [
          {
            model: "mock-model1",
            name: "tasklet1",
            prompt: "mock-prompt1 sdopfkasdfposadk",
            lines: [1, 2, 10]
          },
          {
            model: "mock-model2",
            name: "tasklet2",
            prompt: "mock-prompt2 asdfasdpoifasodf",
            lines: [5, 6, 7]
          },
          {
            model: "mock-model3",
            name: "tasklet3",
            prompt: "mock-prompt3 asdfasdpoifasodf",
            lines: [11]
          }
        ]
      },
      {
        path: "example2.ts",
        tasklets: [
          {
            model: "mock-model1",
            name: "tasklet1",
            prompt: "mock-prompt1 sdopfkasdfposadk",
            lines: [2, 3]
          },
          {
            model: "mock-model2",
            name: "tasklet2",
            prompt: "mock-prompt2 asdfasdpoifasodf",
            lines: [4, 5]
          },
          {
            model: "mock-model3",
            name: "tasklet3",
            prompt: "mock-prompt3 asdfasdpoifasodf",
            lines: [8, 9, 11]
          }
        ]
      }
    ]
  };
}