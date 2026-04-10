import * as vscode from 'vscode';
import { TaskletUI, LineMap } from './history/types';

/**
 * Generates the full HTML for the AI Blame split-panel webview.
 *
 * Left panel  — locked, read-only copy of the file with AI lines highlighted.
 *               Clicking an AI line selects the tasklet and illuminates all
 *               its lines; a second click on the same tasklet deselects it.
 *
 * Right panel — starts blank; shows prompt details once a tasklet is selected.
 */
export function getBlameViewHtml(
  fileContent: string,
  fileName: string,
  fileMap: Map<number, TaskletUI>, // 0-based line -> tasklet
  webview: vscode.Webview
): string {
  // ── Serialise the line→tasklet mapping into a plain JS object ──────────────
  // We only need: which lines belong to which tasklet, and the tasklet metadata.
  // Build two structures:
  //   lineToTaskletId : { [lineIndex: string]: string }  (0-based)
  //   tasklets        : { [id: string]: TaskletData }

  interface TaskletData {
    id: string;
    name: string;
    prompt: string;
    model: string;
    lines: number[]; // 0-based
  }

  const taskletsMap = new Map<TaskletUI, TaskletData>();
  const lineToTaskletId: Record<string, string> = {};

  let idCounter = 0;
  for (const [line, tasklet] of fileMap.entries()) {
    if (!taskletsMap.has(tasklet)) {
      taskletsMap.set(tasklet, {
        id: String(idCounter++),
        name: tasklet.name,
        prompt: tasklet.prompt,
        model: tasklet.model,
        // Convert lines from the tasklet object — they may be 1-based in the
        // source so normalise to 0-based here to match the editor display.
        lines: tasklet.lines.map(l => l - 1),
      });
    }
    lineToTaskletId[String(line)] = taskletsMap.get(tasklet)!.id;
  }

  const tasklets: Record<string, TaskletData> = {};
  for (const data of taskletsMap.values()) {
    tasklets[data.id] = data;
  }

  // Escape the raw file content so it can live inside a JSON string safely.
  const linesJson = JSON.stringify(fileContent.split('\n'));
  const lineMapJson = JSON.stringify(lineToTaskletId);
  const taskletsJson = JSON.stringify(tasklets);

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AI Blame — ${escapeHtml(fileName)}</title>
  <style>
    /* ── Reset & base ─────────────────────────────────────────────────── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:           #0d0f14;
      --surface:      #13161e;
      --border:       #1e2330;
      --text:         #c9d1e0;
      --text-dim:     #5a6480;
      --text-bright:  #e8edf5;
      --accent:       #8040ff;
      --accent-dim:   rgba(128, 0, 255, 0.18);
      --accent-glow:  rgba(128, 0, 255, 0.55);
      --selected-bg:  rgba(128, 0, 255, 0.55);
      --unselected-bg:rgba(128, 0, 255, 0.18);
      --line-num:     #3a4060;
      --font-mono:    'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
      --font-ui:      'Inter', 'Segoe UI', system-ui, sans-serif;
      --radius:       6px;
    }

    html, body {
      height: 100%;
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-ui);
      overflow: hidden;
    }

    /* ── Layout ───────────────────────────────────────────────────────── */
    #root {
      display: flex;
      flex-direction: column;
      height: 100vh;
    }

    #header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 16px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }

    #header .icon {
      width: 18px;
      height: 18px;
      opacity: .7;
    }

    #header .filename {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-bright);
      letter-spacing: .02em;
    }

    #header .badge {
      margin-left: auto;
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 20px;
      background: var(--accent-dim);
      color: var(--accent);
      border: 1px solid var(--accent);
      letter-spacing: .06em;
      text-transform: uppercase;
    }

    #panels {
      display: flex;
      flex: 1;
      overflow: hidden;
    }

    /* ── File panel (left) ────────────────────────────────────────────── */
    #file-panel {
      flex: 1 1 55%;
      display: flex;
      flex-direction: column;
      border-right: 1px solid var(--border);
      overflow: hidden;
    }

    #file-scroll {
      flex: 1;
      overflow-y: auto;
      overflow-x: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--border) transparent;
    }

    #file-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
    #file-scroll::-webkit-scrollbar-track { background: transparent; }
    #file-scroll::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

    table.code-table {
      width: 100%;
      border-collapse: collapse;
      font-family: var(--font-mono);
      font-size: 12.5px;
      line-height: 1.65;
      table-layout: fixed;
    }

    col.col-num  { width: 52px; }
    col.col-code { width: auto; }

    tr { transition: background 80ms ease; }

    td.line-num {
      width: 52px;
      min-width: 52px;
      text-align: right;
      padding: 0 12px 0 0;
      color: var(--line-num);
      user-select: none;
      vertical-align: top;
      font-size: 11px;
    }

    td.line-code {
      padding: 0 16px 0 8px;
      white-space: pre;
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* AI line states */
    tr.ai-line td { background: var(--unselected-bg); }
    tr.ai-line td.line-num { color: var(--accent); opacity: .7; }
    tr.ai-line { cursor: pointer; }
    tr.ai-line:hover td { background: rgba(128,0,255,.28); }

    tr.ai-selected td { background: var(--selected-bg) !important; }
    tr.ai-selected td.line-num { color: var(--accent); opacity: 1; }

    /* ── Prompt panel (right) ─────────────────────────────────────────── */
    #prompt-panel {
      flex: 1 1 45%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-width: 280px;
    }

    #prompt-header {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      font-size: 11px;
      color: var(--text-dim);
      letter-spacing: .08em;
      text-transform: uppercase;
      flex-shrink: 0;
    }

    #prompt-content {
      flex: 1;
      overflow-y: auto;
      padding: 0;
      scrollbar-width: thin;
      scrollbar-color: var(--border) transparent;
    }

    #prompt-content::-webkit-scrollbar { width: 6px; }
    #prompt-content::-webkit-scrollbar-track { background: transparent; }
    #prompt-content::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

    /* ── Blank state ──────────────────────────────────────────────────── */
    #blank-state {
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      color: var(--text-dim);
      user-select: none;
    }

    #blank-state .hint-icon {
      width: 40px;
      height: 40px;
      opacity: .25;
    }

    #blank-state p {
      font-size: 12px;
      letter-spacing: .04em;
    }

    /* ── Tasklet card ─────────────────────────────────────────────────── */
    .tasklet-card {
      padding: 20px 20px 0;
      animation: fadeSlide .18s ease both;
    }

    @keyframes fadeSlide {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .card-title {
      font-family: var(--font-mono);
      font-size: 13px;
      font-weight: 600;
      color: var(--text-bright);
      margin-bottom: 4px;
    }

    .card-meta {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }

    .meta-pill {
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 20px;
      border: 1px solid var(--border);
      color: var(--text-dim);
      letter-spacing: .04em;
    }

    .meta-pill.accent {
      border-color: var(--accent);
      color: var(--accent);
      background: var(--accent-dim);
    }

    .section-label {
      font-size: 10px;
      letter-spacing: .1em;
      text-transform: uppercase;
      color: var(--text-dim);
      margin-bottom: 8px;
    }

    .prompt-box {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 14px 16px;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.7;
      color: var(--text);
      white-space: pre-wrap;
      word-break: break-word;
      margin-bottom: 20px;
    }

    .lines-section {
      margin-bottom: 24px;
    }

    .lines-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .line-chip {
      font-family: var(--font-mono);
      font-size: 10px;
      padding: 2px 7px;
      border-radius: 4px;
      background: var(--accent-dim);
      color: var(--accent);
      border: 1px solid rgba(128,0,255,.3);
      cursor: pointer;
      transition: background 100ms;
    }

    .line-chip:hover {
      background: var(--accent-glow);
      color: #fff;
    }

    /* ── Resize handle ────────────────────────────────────────────────── */
    #resize-handle {
      width: 4px;
      cursor: col-resize;
      background: var(--border);
      flex-shrink: 0;
      transition: background 150ms;
      position: relative;
      z-index: 10;
    }

    #resize-handle:hover,
    #resize-handle.dragging { background: var(--accent); }
  </style>
</head>
<body>
<div id="root">

  <!-- Header -->
  <div id="header">
    <svg class="icon" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="10" cy="10" r="8" stroke="#8040ff" stroke-width="1.5"/>
      <path d="M6.5 10 L9 12.5 L13.5 7.5" stroke="#8040ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span class="filename">${escapeHtml(fileName)}</span>
    <span class="badge">AI Blame</span>
  </div>

  <!-- Two-panel area -->
  <div id="panels">

    <!-- Left: locked file -->
    <div id="file-panel">
      <div id="file-scroll">
        <table class="code-table" id="code-table">
          <colgroup>
            <col class="col-num" />
            <col class="col-code" />
          </colgroup>
          <tbody id="code-body"></tbody>
        </table>
      </div>
    </div>

    <!-- Resize handle -->
    <div id="resize-handle"></div>

    <!-- Right: prompt details -->
    <div id="prompt-panel">
      <div id="prompt-header">Prompt Details</div>
      <div id="prompt-content">
        <div id="blank-state">
          <svg class="hint-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M15 15l6 6M10 17a7 7 0 1 1 0-14 7 7 0 0 1 0 14z"
              stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          <p>Click a highlighted line to view its prompt</p>
        </div>
      </div>
    </div>

  </div><!-- /panels -->
</div><!-- /root -->

<script>
  (function () {
    'use strict';

    // ── Data injected from the extension ──────────────────────────────
    const LINES        = ${linesJson};
    const LINE_MAP     = ${lineMapJson};   // "lineIndex" -> taskletId
    const TASKLETS     = ${taskletsJson};  // taskletId  -> TaskletData

    // ── State ──────────────────────────────────────────────────────────
    let selectedTaskletId = null;

    // ── Build code table ───────────────────────────────────────────────
    const tbody = document.getElementById('code-body');

    LINES.forEach((text, idx) => {
      const isAi = LINE_MAP[String(idx)] !== undefined;
      const tr   = document.createElement('tr');
      if (isAi) tr.classList.add('ai-line');

      tr.dataset.line = String(idx);

      const tdNum  = document.createElement('td');
      tdNum.className = 'line-num';
      tdNum.textContent = String(idx + 1);

      const tdCode = document.createElement('td');
      tdCode.className = 'line-code';
      // Use textContent for safety — no HTML injection from file content
      tdCode.textContent = text;

      tr.appendChild(tdNum);
      tr.appendChild(tdCode);
      tbody.appendChild(tr);

      if (isAi) {
        tr.addEventListener('click', () => handleLineClick(idx));
      }
    });

    // ── Click handler ──────────────────────────────────────────────────
    function handleLineClick(lineIdx) {
      const taskletId = LINE_MAP[String(lineIdx)];
      if (taskletId === undefined) { return; }

      if (selectedTaskletId === taskletId) {
        // Second click on same tasklet → deselect
        selectedTaskletId = null;
        clearSelection();
        showBlank();
      } else {
        selectedTaskletId = taskletId;
        applySelection(taskletId);
        showPrompt(taskletId);
      }
    }

    // ── Highlight helpers ──────────────────────────────────────────────
    function clearSelection() {
      document.querySelectorAll('tr.ai-selected').forEach(tr =>
        tr.classList.remove('ai-selected')
      );
    }

    function applySelection(taskletId) {
      clearSelection();
      const tasklet = TASKLETS[taskletId];
      if (!tasklet) { return; }

      tasklet.lines.forEach(lineIdx => {
        const tr = tbody.querySelector('tr[data-line="' + lineIdx + '"]');
        if (tr) { tr.classList.add('ai-selected'); }
      });

      // Scroll first selected line into view (with a little top margin)
      const firstTr = tbody.querySelector('tr.ai-selected');
      if (firstTr) {
        firstTr.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }

    // ── Prompt panel ───────────────────────────────────────────────────
    const promptContent = document.getElementById('prompt-content');

    function showBlank() {
      promptContent.innerHTML = \`
        <div id="blank-state">
          <svg class="hint-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M15 15l6 6M10 17a7 7 0 1 1 0-14 7 7 0 0 1 0 14z"
              stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          <p>Click a highlighted line to view its prompt</p>
        </div>
      \`;
    }

    function showPrompt(taskletId) {
      const t = TASKLETS[taskletId];
      if (!t) { return; }

      // Build line chips  (display as 1-based)
      const chips = t.lines
        .slice()
        .sort((a, b) => a - b)
        .map(l => \`<span class="line-chip" data-line="\${l}" title="Jump to line \${l + 1}">L\${l + 1}</span>\`)
        .join('');

      promptContent.innerHTML = \`
        <div class="tasklet-card">
          <div class="card-title">\${esc(t.name)}</div>
          <div class="card-meta">
            <span class="meta-pill accent">\${esc(t.model)}</span>
            <span class="meta-pill">\${t.lines.length} line\${t.lines.length !== 1 ? 's' : ''}</span>
          </div>

          <div class="section-label">Prompt</div>
          <div class="prompt-box">\${esc(t.prompt)}</div>

          <div class="lines-section">
            <div class="section-label">Lines</div>
            <div class="lines-chips">\${chips}</div>
          </div>
        </div>
      \`;

      // Wire up line chips to scroll the code table
      promptContent.querySelectorAll('.line-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const lineIdx = parseInt(chip.dataset.line, 10);
          const tr = tbody.querySelector('tr[data-line="' + lineIdx + '"]');
          if (tr) { tr.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
        });
      });
    }

    // ── Simple HTML escaper ────────────────────────────────────────────
    function esc(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // ── Drag-to-resize the two panels ─────────────────────────────────
    const handle      = document.getElementById('resize-handle');
    const filePanel   = document.getElementById('file-panel');
    const promptPanel = document.getElementById('prompt-panel');
    const panelsEl    = document.getElementById('panels');

    let dragging = false;

    handle.addEventListener('mousedown', e => {
      dragging = true;
      handle.classList.add('dragging');
      e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
      if (!dragging) { return; }
      const rect  = panelsEl.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      const pct   = Math.min(Math.max(ratio * 100, 25), 75);
      filePanel.style.flex   = '0 0 ' + pct + '%';
      promptPanel.style.flex = '0 0 ' + (100 - pct) + '%';
    });

    document.addEventListener('mouseup', () => {
      dragging = false;
      handle.classList.remove('dragging');
    });

  })();
</script>
</body>
</html>`;
}

/** Escape characters that are unsafe in HTML text nodes / attribute values */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}