import { marked } from "marked";
import { TaskletMessage } from "./history/types";
// Returns the HTML content for the prompt webview panel
export function getPromptPanelHtml(taskletMessages: TaskletMessage[], title: string, model: string, lines: number[]): string {
  const promptBoxesHtml = taskletMessages.map(msg => `
      <div class="message-box ${msg.type} ${msg.stage}">
        ${marked.parse(msg.message)}
      </div>
  `).join('\n');

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Tracybot Prompt</title>
      <style>
        body {
          font-family: var(--vscode-font-family);
          font-size: var(--vscode-font-size);
          color: var(--vscode-foreground);
          background-color: var(--vscode-editor-background);
          padding: 20px;
        }
        h2 {
          color: var(--vscode-textLink-foreground);
          margin-bottom: 16px;
        }
        .message-box {
          background-color: var(--vscode-textBlockQuote-background);
          padding: 12px 16px;
          border-radius: 4px;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .prompt {
          border-left-style: solid;
          border-left-width: 4px;
        }
        .response {
          border-right-style: solid;
          border-right-width: 4px;
        }
        .build {
          border-color: var(--vscode-charts-blue);
        }
        .plan {
          border-color: var(--vscode-charts-orange);
        }
        .message-box p {
          margin: 0;
          padding: 0;
        }
        .nav-bar {
          display: flex;
          align-items: center;
          justify-content: space-evenly;
        }
        button {
          background-color: var(--vscode-textLink-foreground);
          border: none;
          padding: 5px;
          font-weight: bold;
          font-size: 12px;
          border-radius: 5px;
        }
      </style>
    </head>
    <body>
      <div class="nav-bar">
        <div class="column">
          <h2>${title}</h2>
        </div>
        <div class="column">
          <button type="button" onclick="openTaskletMenu()">All Tasklets</button>
        </div>
      </div>

      <div class="meta-info">
        <p><strong>MODEL:</strong> ${model}</p>
        <p><strong>LINES:</strong> ${lines.join(', ')}</p>
      </div>

      ${promptBoxesHtml}
    </body>
    <script>
      const vscode = acquireVsCodeApi();

      function openTaskletMenu() {
        vscode.postMessage({
          command: 'openTaskletMenu'
        });
      }
    </script>
    </html>
  `;
}
