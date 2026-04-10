export function openTaskletMenu(tasklets: string[]): string {
  const list = tasklets
    .map((t, i) => `<li onclick="openTasklet(${i})">${t}</li>`)
    .join('');

  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <style>
          h2 {
            text-align: center;
            font-size: 24px;
            color: var(--vscode-textLink-foreground);
          }
          ul {
            list-style: none;
            display: flex; 
            flex-direction: column; 
            align-items: center;
            padding: 0px;
            margin: 0px;
          }
          li {
            cursor: pointer;
          }
          li:hover {
            text-decoration: underline;
            color: var(--vscode-textLink-foreground);
          }
        </style>
      </head>
      <body>
        <h2>Tasklets</h2>
        <ul>
          ${list}
        </ul>

        <script>
          const vscode = acquireVsCodeApi();

          function openTasklet(index) {
            vscode.postMessage({
              command: 'openTasklet',
              index: index
            });
          }
        </script>
      </body>
    </html>
  `;
}