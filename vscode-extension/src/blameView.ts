import * as vscode from 'vscode';
import { TaskletUI, TaskletMessage } from './history/types';
import { getContiguousChunks } from './utils';

interface TaskletData {
  id: string;
  name: string;
  model: string;
  lines: number[];     // 0-based
  messages: TaskletMessage[];
  chunks: number[][];  // pre-computed contiguous line runs
}

export function getBlameViewHtml(
  fileContent: string,
  fileName: string,
  fileMap: Map<number, TaskletUI>,
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): string {
  const tasklets: Record<string, TaskletData> = {};
  const lineToTaskletId: Record<string, string> = {};
  const seenTasklets = new Map<TaskletUI, string>();

  let idCounter = 0;
  for (const [line, tasklet] of fileMap.entries()) {
    let id = seenTasklets.get(tasklet);
    if (id === undefined) {
      id = String(idCounter++);
      seenTasklets.set(tasklet, id);
      const lines0 = tasklet.lines.map(l => l - 1);
      tasklets[id] = {
        id,
        name: tasklet.name,
        model: tasklet.model,
        lines: lines0,
        messages: tasklet.messages ?? [],
        chunks: getContiguousChunks(lines0),
      };
    }
    lineToTaskletId[String(line)] = id;
  }

  const linesJson    = JSON.stringify(fileContent.split('\n'));
  const lineMapJson  = JSON.stringify(lineToTaskletId);
  const taskletsJson = JSON.stringify(tasklets);
  const fileNameJson = JSON.stringify(fileName);

  const mediaUri = (file: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));

  const cssUri = mediaUri('blameView.css');
  const jsUri  = mediaUri('blameView.js');

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AI Blame — ${escapeHtml(fileName)}</title>
  <link id="hljs-theme" rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css">
  <link rel="stylesheet" href="${cssUri}">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/marked/9.1.6/marked.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
</head>
<body>
<div id="root">

  <div id="header">
    <svg class="icon" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="10" cy="10" r="8" stroke="#8040ff" stroke-width="1.5"/>
      <path d="M6.5 10 L9 12.5 L13.5 7.5" stroke="#8040ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span class="filename">${escapeHtml(fileName)}</span>
    <span class="badge">AI Blame</span>
  </div>

  <div id="panels">

    <div id="file-panel">
      <div id="file-scroll">
        <table class="code-table">
          <colgroup><col class="col-num" /><col /></colgroup>
          <tbody id="code-body"></tbody>
        </table>
      </div>
    </div>

    <div id="resize-handle"></div>

    <div id="prompt-panel">
      <div id="prompt-header">Prompt Details</div>
      <div id="prompt-content">
        <div id="blank-state">
          <svg class="hint-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M15 15l6 6M10 17a7 7 0 1 1 0-14 7 7 0 0 1 0 14z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          <p>Click a highlighted line to view its prompt</p>
        </div>
      </div>
    </div>

  </div>
</div>

<script>
  // global constants for the webview script; these are populated by the server based on the file being viewed and the blame data we have for it
  const LINES    = ${linesJson};
  const LINE_MAP = ${lineMapJson};
  const TASKLETS = ${taskletsJson};
  const FILE_NAME = ${fileNameJson};
</script>
<script src="${jsUri}"></script>
</body>
</html>`;
}

// Server-side HTML escaper; esc() in the webview script is its browser-side counterpart
function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
