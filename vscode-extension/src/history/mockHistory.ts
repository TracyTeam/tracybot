import { History } from "./types";

// This function simulates fetching data from git and returning the results
export function getMockHistory(): History {
  return {
    id: "mock-id",
    files: [
      {
        path: "example.ts",
        tasklets: [
          {
            model: "mock-model1",
            name: "tasklet1",
            prompt: "## mock-prompt1 \n**this should be bold** \n_this should be italic_ \n1. list \n2. here [link](https://www.google.com)",
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