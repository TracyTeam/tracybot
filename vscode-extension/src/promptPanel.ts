import { marked } from "marked";
// Returns the HTML content for the prompt webview panel
export function getPromptPanelHtml(prompt: string, message: string, model: string, lines: number[]): string {
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
        .prompt-box {
          background-color: var(--vscode-textBlockQuote-background);
          border-left: 4px solid var(--vscode-textLink-foreground);
          padding: 12px 16px;
          border-radius: 4px;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .prompt-box p {
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
          <h2>${message}</h2>
        </div>
        <div class="column">
          <button type="button" onclick="openTaskletMenu()">All Tasklets</button>
        </div>
      </div>

      <div class="prompt-box">
        <p>MODEL: ${model}</p>
        ${marked.parse(prompt)}
        <p>LINES: ${lines}</p>
      </div>
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