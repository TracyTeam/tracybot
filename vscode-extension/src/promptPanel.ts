// Returns the HTML content for the prompt webview panel
export function getPromptPanelHtml(prompt: string): string {
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
          line-height: 1.6;
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
      </style>
    </head>
    <body>
      <h2>Tracybot Prompt</h2>
      <div class="prompt-box">${prompt}</div>
    </body>
    </html>
  `;
}