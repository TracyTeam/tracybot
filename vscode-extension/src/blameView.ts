import * as vscode from 'vscode';
import { TaskletUI, TaskletMessage } from './history/types';
import { getContiguousChunks } from './utils';

interface TaskletData {
  id: string;
  name: string;
  model: string;
  lines: number[];        // 0-based, currently-owned (live)
  ghostLines: number[];   // 0-based, previously-owned but overridden
  messages: TaskletMessage[];
  chunks: number[][];     // pre-computed contiguous live line runs
  originCommitHash?: string;
}

export function getBlameViewHtml(
  fileContent: string,
  fileName: string,
  fileMap: Map<number, TaskletUI>,
  fileTasklets: TaskletUI[],
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  initialLine?: number
): string {
  const tasklets: Record<string, TaskletData> = {};
  const lineToTaskletId: Record<string, string> = {};
  const linePrevious: Record<string, string[]> = {};

  // Build the tasklet record. fileTasklets is in chronological order
  // (oldest -> newest); we preserve that ordering so the previous-tasklets
  // dropdown can show history naturally.
  for (const t of fileTasklets) {
    const lines0 = t.lines.map(l => l - 1);
    const ghost0 = (t.ghostLines ?? []).map(l => l - 1);
    tasklets[t.id] = {
      id: t.id,
      name: t.name,
      model: t.model,
      lines: lines0,
      ghostLines: ghost0,
      messages: t.messages ?? [],
      chunks: getContiguousChunks(lines0),
      originCommitHash: t.originCommitHash,
    };
  }

  // Map line -> current live owner (only live lines).
  for (const [line, tasklet] of fileMap.entries()) {
    lineToTaskletId[String(line)] = tasklet.id;
  }

  // For each line in the file, the chronological list of tasklets that touched
  // it (live or ghost) excluding the current live owner. Only tasklets that
  // still have surviving (live) lines somewhere are included — fully-overridden
  // tasklets are hidden from both the dropdown and the All Tasklets view.
  for (const t of fileTasklets) {
    if (t.lines.length === 0) { continue; }
    const lines0 = t.lines.map(l => l - 1);
    const ghost0 = (t.ghostLines ?? []).map(l => l - 1);
    const touched = new Set<number>([...lines0, ...ghost0]);
    for (const l of touched) {
      const owner = lineToTaskletId[String(l)];
      if (owner === t.id) { continue; }
      if (!linePrevious[String(l)]) { linePrevious[String(l)] = []; }
      if (!linePrevious[String(l)].includes(t.id)) {
        linePrevious[String(l)].push(t.id);
      }
    }
  }

  const linesJson        = JSON.stringify(fileContent.split('\n'));
  const lineMapJson      = JSON.stringify(lineToTaskletId);
  const linePreviousJson = JSON.stringify(linePrevious);
  const taskletsJson     = JSON.stringify(tasklets);
  const fileNameJson     = JSON.stringify(fileName);
  const initialLineJson  = JSON.stringify(initialLine ?? null);

  const mediaUri = (file: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));

  const cssUri = mediaUri('blameView.css');
  const jsUri = mediaUri('blameView.js');

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
  // global constants for the webview script; populated by the server based on
  // the file being viewed and the blame data we have for it
  const LINES         = ${escapeScriptTag(linesJson)};
  const LINE_MAP      = ${escapeScriptTag(lineMapJson)};
  const LINE_PREVIOUS = ${escapeScriptTag(linePreviousJson)};
  const TASKLETS      = ${escapeScriptTag(taskletsJson)};
  const FILE_NAME     = ${escapeScriptTag(fileNameJson)};
  const INITIAL_LINE  = ${escapeScriptTag(initialLineJson)};
</script>
<script src="${jsUri}"></script>
</body>
</html>`;
}

function escapeScriptTag(json: string): string {
  return json.replace(/<\/script/g, '<\\/script');
}

// Server-side HTML escaper; esc() in the webview script is its browser-side counterpart
function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
