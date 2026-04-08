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
            messages: [],
            lines: [1, 2, 10]
          },
          {
            model: "mock-model2",
            name: "tasklet2",
            messages: [],
            lines: [5, 6, 7]
          },
          {
            model: "mock-model3",
            name: "tasklet3",
            messages: [],
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
            messages: [],
            lines: [2, 3]
          },
          {
            model: "mock-model2",
            name: "tasklet2",
            messages: [],
            lines: [4, 5]
          },
          {
            model: "mock-model3",
            name: "tasklet3",
            messages: [],
            lines: [8, 9, 11]
          }
        ]
      }
    ]
  };
}
