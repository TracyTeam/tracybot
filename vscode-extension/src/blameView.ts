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
  fileMap: Map<number, TaskletUI>
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

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AI Blame — ${escapeHtml(fileName)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:            #0d0f14;
      --surface:       #13161e;
      --border:        #1e2330;
      --text:          #c9d1e0;
      --text-dim:      #5a6480;
      --text-bright:   #e8edf5;
      --accent:        #8040ff;
      --accent-dim:    rgba(128, 0, 255, 0.18);
      --accent-glow:   rgba(128, 0, 255, 0.55);
      --selected-bg:   rgba(128, 0, 255, 0.55);
      --unselected-bg: rgba(128, 0, 255, 0.18);
      --line-num:      #3a4060;
      --font-mono:     'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
      --font-ui:       'Inter', 'Segoe UI', system-ui, sans-serif;
      --radius:        6px;
    }

    html, body { height: 100%; background: var(--bg); color: var(--text); font-family: var(--font-ui); overflow: hidden; }

    /* ── Root layout ── */
    #root { display: flex; flex-direction: column; height: 100vh; }

    #header {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 16px;
      background: var(--surface); border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    #header .icon     { width: 18px; height: 18px; opacity: .7; }
    #header .filename { font-family: var(--font-mono); font-size: 12px; color: var(--text-bright); letter-spacing: .02em; }
    #header .badge    {
      margin-left: auto; font-size: 10px; padding: 2px 8px; border-radius: 20px;
      background: var(--accent-dim); color: var(--accent); border: 1px solid var(--accent);
      letter-spacing: .06em; text-transform: uppercase;
    }

    #panels { display: flex; flex: 1; overflow: hidden; }

    /* ── Left: file panel ── */
    #file-panel   { flex: 1 1 55%; display: flex; flex-direction: column; border-right: 1px solid var(--border); overflow: hidden; }
    #file-scroll  { flex: 1; overflow-y: auto; overflow-x: auto; scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
    #file-scroll::-webkit-scrollbar       { width: 6px; height: 6px; }
    #file-scroll::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

    table.code-table { width: 100%; border-collapse: collapse; font-family: var(--font-mono); font-size: 12.5px; line-height: 1.65; table-layout: fixed; }
    col.col-num  { width: 52px; }
    tr { transition: background 80ms ease; }
    td.line-num  { width: 52px; min-width: 52px; text-align: right; padding: 0 12px 0 0; color: var(--line-num); user-select: none; vertical-align: top; font-size: 11px; }
    td.line-code { padding: 0 16px 0 8px; white-space: pre; color: var(--text); overflow: hidden; text-overflow: ellipsis; }

    tr.ai-line td              { background: var(--unselected-bg); }
    tr.ai-line td.line-num     { color: var(--accent); opacity: .7; }
    tr.ai-line                 { cursor: pointer; }
    tr.ai-line:hover td        { background: rgba(128,0,255,.28); }
    tr.ai-selected td          { background: var(--selected-bg) !important; }
    tr.ai-selected td.line-num { color: var(--accent); opacity: 1; }

    /* ── Right: prompt panel ── */
    #prompt-panel   { flex: 1 1 45%; display: flex; flex-direction: column; overflow: hidden; min-width: 280px; }
    #prompt-header  { padding: 12px 16px; border-bottom: 1px solid var(--border); font-size: 11px; color: var(--text-dim); letter-spacing: .08em; text-transform: uppercase; flex-shrink: 0; }
    #prompt-content { flex: 1; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
    #prompt-content::-webkit-scrollbar       { width: 6px; }
    #prompt-content::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

    /* ── Blank state ── */
    #blank-state           { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--text-dim); user-select: none; }
    #blank-state .hint-icon { width: 40px; height: 40px; opacity: .25; }
    #blank-state p          { font-size: 12px; letter-spacing: .04em; }

    /* ── Tasklet card ── */
    .tasklet-card { padding: 16px 20px 0; animation: fadeSlide .18s ease both; }

    @keyframes fadeSlide {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    /* Single header row: [title] [model pill] [line-count pill] →→ [button] */
    .card-nav {
      display: flex;
      align-items: center;
      flex-wrap: nowrap;
      gap: 6px;
      min-width: 0;
      margin-bottom: 12px;
    }

    .card-title {
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 600;
      color: var(--text-bright);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
      flex: 1 1 0;
    }

    .meta-pill {
      font-size: 10px;
      padding: 2px 7px;
      border-radius: 20px;
      border: 1px solid var(--border);
      color: var(--text-dim);
      letter-spacing: .04em;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .meta-pill.accent { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }

    .menu-btn {
      font-family: var(--font-ui);
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 4px;
      border: 1px solid var(--border);
      cursor: pointer;
      background: transparent;
      color: var(--text-dim);
      letter-spacing: .04em;
      white-space: nowrap;
      flex-shrink: 0;
      margin-left: auto;
      transition: border-color 120ms, color 120ms, background 120ms;
    }
    .menu-btn:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }

    /* ── Section label ── */
    .section-label { font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--text-dim); margin-bottom: 8px; }

    /* ── Message boxes (matching old promptPanel.ts design) ── */
    .messages-section { display: flex; flex-direction: column; gap: 8px; margin-bottom: 20px; }

    .message-box {
      background-color: var(--vscode-textBlockQuote-background, rgba(255,255,255,0.05));
      padding: 12px 16px;
      border-radius: var(--radius);
      word-break: break-word;
      font-size: 13px;
      line-height: 1.7;
      color: var(--text);
    }
    /* prompt → left border, response → right border; build → blue, plan → orange */
    .message-box.prompt   { border-left:  4px solid transparent; }
    .message-box.response { border-right: 4px solid transparent; }
    .message-box.build { border-color: var(--vscode-charts-blue,   #3794ff); }
    .message-box.plan  { border-color: var(--vscode-charts-orange, #e8a24a); }

    /* stage label above each box */
    .message-label {
      font-size: 9px;
      letter-spacing: .1em;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .message-label.build { color: var(--vscode-charts-blue,   #3794ff); }
    .message-label.plan  { color: var(--vscode-charts-orange, #e8a24a); }

    /* markdown content inside message boxes */
    .message-box p                  { margin: 0 0 8px; }
    .message-box p:last-child       { margin-bottom: 0; }
    .message-box code               { font-family: var(--font-mono); font-size: 11.5px; background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 3px; }
    .message-box pre                { background: rgba(255,255,255,0.06); padding: 10px 12px; border-radius: 4px; overflow-x: auto; margin: 8px 0; }
    .message-box pre code           { background: none; padding: 0; }
    .message-box ul, .message-box ol { padding-left: 20px; margin: 6px 0; }
    
    .questions-section { margin-top: 12px; }
    .question-item {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 10px 12px;
      margin-bottom: 8px;
    }
    .question-item:last-child { margin-bottom: 0; }
    .question-header {
      font-size: 10px;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: var(--text-dim);
      margin-bottom: 6px;
    }
    .question-text {
      font-size: 12px;
      color: var(--text);
      line-height: 1.5;
    }
    /* ── Chunk chips ── */
    .lines-section { margin-bottom: 24px; }
    .lines-chips   { display: flex; flex-wrap: wrap; gap: 4px; }

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
      user-select: none;
    }
    .line-chip:hover { background: var(--accent-glow); color: #fff; }

    /* ── Tasklet menu view ── */
    .tasklet-menu { padding: 20px 20px 0; animation: fadeSlide .18s ease both; }
    .menu-title   { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--text-dim); margin-bottom: 12px; }

    .tasklet-list    { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 2px; }
    .tasklet-list li { padding: 8px 12px; border-radius: var(--radius); cursor: pointer; font-size: 13px; color: var(--text); border: 1px solid transparent; transition: background 100ms, border-color 100ms; }
    .tasklet-list li:hover { background: var(--accent-dim); border-color: rgba(128,0,255,.25); color: var(--text-bright); }

    /* ── Resize handle ── */
    #resize-handle { width: 4px; cursor: col-resize; background: var(--border); flex-shrink: 0; transition: background 150ms; }
    #resize-handle:hover, #resize-handle.dragging { background: var(--accent); }
  </style>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/marked/9.1.6/marked.min.js"></script>
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
  (function () {
    'use strict';

    const LINES    = ${linesJson};
    const LINE_MAP = ${lineMapJson};
    const TASKLETS = ${taskletsJson};

    let selectedTaskletId = null;

    const tbody = document.getElementById('code-body');

    LINES.forEach((text, idx) => {
      const isAi = LINE_MAP[String(idx)] !== undefined;
      const tr   = document.createElement('tr');
      if (isAi) { tr.classList.add('ai-line'); }
      tr.dataset.line = String(idx);

      const tdNum = document.createElement('td');
      tdNum.className   = 'line-num';
      tdNum.textContent = String(idx + 1);

      const tdCode = document.createElement('td');
      tdCode.className   = 'line-code';
      tdCode.textContent = text;

      tr.appendChild(tdNum);
      tr.appendChild(tdCode);
      tbody.appendChild(tr);

      if (isAi) { tr.addEventListener('click', () => handleLineClick(idx)); }
    });

    function handleLineClick(lineIdx) {
      const taskletId = LINE_MAP[String(lineIdx)];
      if (taskletId === undefined) { return; }

      if (selectedTaskletId === taskletId) {
        selectedTaskletId = null;
        clearSelection();
        showBlank();
      } else {
        selectedTaskletId = taskletId;
        applySelection(taskletId);
        showPrompt(taskletId);
      }
    }

    function clearSelection() {
      document.querySelectorAll('tr.ai-selected').forEach(tr => tr.classList.remove('ai-selected'));
    }

    function applySelection(taskletId) {
      clearSelection();
      const tasklet = TASKLETS[taskletId];
      if (!tasklet) { return; }
      tasklet.lines.forEach(li => {
        const tr = tbody.querySelector(\`tr[data-line="\${li}"]\`);
        if (tr) { tr.classList.add('ai-selected'); }
      });
      const first = tbody.querySelector('tr.ai-selected');
      if (first) { first.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    }

    const promptContent = document.getElementById('prompt-content');

    function showBlank() {
      promptContent.innerHTML = \`
        <div id="blank-state">
          <svg class="hint-icon" viewBox="0 0 24 24" fill="none">
            <path d="M15 15l6 6M10 17a7 7 0 1 1 0-14 7 7 0 0 1 0 14z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          <p>Click a highlighted line to view its prompt</p>
        </div>\`;
    }

    function renderMd(text) {
      if (!text) { return ''; }
      return (typeof marked !== 'undefined') ? marked.parse(text, { breaks: true }) : \`<p>\${esc(text)}</p>\`;
    }

    function showPrompt(taskletId) {
      const t = TASKLETS[taskletId];
      if (!t) { return; }

      const chunkChips = t.chunks.map(chunk => {
        const first = chunk[0];
        const last  = chunk[chunk.length - 1];
        const label = first === last ? \`\${first + 1}\` : \`\${first + 1}–\${last + 1}\`;
        return \`<span class="line-chip" data-first="\${first}" data-last="\${last}">\${label}</span>\`;
      }).join('');

    const messagesHtml = (t.messages && t.messages.length > 0)
        ? t.messages.map(msg => {
            const questionsHtml = (msg.questions && msg.questions.length > 0)
              ? msg.questions.map(q => \`
                  <div class="question-item">
                    <div class="question-header">\${esc(q.header)}</div>
                    <div class="question-text">\${esc(q.question)}</div>
                  </div>
                \`).join('')
              : '';
            return \`
              <div>
                <div class="message-label \${esc(msg.stage)}">\${esc(msg.stage)} · \${esc(msg.type)}</div>
                <div class="message-box \${esc(msg.type)} \${esc(msg.stage)}">\${renderMd(msg.message)}</div>
                \${questionsHtml ? \`<div class="questions-section">\${questionsHtml}</div>\` : ''}
              </div>\`;
          }).join('')
        : \`<div class="message-box prompt build"><p><em>No messages recorded for this tasklet.</em></p></div>\`;

      promptContent.innerHTML = \`
        <div class="tasklet-card">
          <div class="card-nav">
            <div class="card-title">\${esc(t.name)}</div>
            <span class="meta-pill accent">\${esc(t.model)}</span>
            <span class="meta-pill">\${t.lines.length}&nbsp;line\${t.lines.length !== 1 ? 's' : ''}</span>
            <button class="menu-btn" id="all-tasklets-btn">All Tasklets</button>
          </div>

          <div class="section-label">Messages</div>
          <div class="messages-section">\${messagesHtml}</div>

          <div class="lines-section">
            <div class="section-label">Chunks</div>
            <div class="lines-chips">\${chunkChips}</div>
          </div>
        </div>\`;

      promptContent.querySelectorAll('.line-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const firstLine = parseInt(chip.dataset.first, 10);
          const lastLine  = parseInt(chip.dataset.last,  10);
          const firstTr = tbody.querySelector(\`tr[data-line="\${firstLine}"]\`);
          const lastTr  = tbody.querySelector(\`tr[data-line="\${lastLine}"]\`);
          if (firstTr) { firstTr.scrollIntoView({ block: 'start',   behavior: 'smooth' }); }
          if (lastTr)  { lastTr.scrollIntoView({  block: 'nearest', behavior: 'smooth' }); }
        });
      });

      document.getElementById('all-tasklets-btn').addEventListener('click', () => {
        showTaskletMenu();
      });
    }

    // ── Tasklet menu ──────────────────────────────────────────────────────────
    const TASKLET_LIST = Object.values(TASKLETS);

    function showTaskletMenu() {
      const items = TASKLET_LIST
        .map(t => \`<li data-id="\${esc(t.id)}">\${esc(t.name)}</li>\`)
        .join('');

      promptContent.innerHTML = \`
        <div class="tasklet-menu">
          <div class="menu-title">All Tasklets</div>
          <ul class="tasklet-list">\${items}</ul>
        </div>\`;

      promptContent.querySelectorAll('.tasklet-list li').forEach(li => {
        li.addEventListener('click', () => {
          const id = li.dataset.id;
          selectedTaskletId = id;
          applySelection(id);
          showPrompt(id);
        });
      });
    }

    // esc() is the browser-side HTML escaper; escapeHtml() in the TS host is its counterpart
    function esc(str) {
      return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ── Drag-to-resize ────────────────────────────────────────────────────────
    const handle      = document.getElementById('resize-handle');
    const filePanel   = document.getElementById('file-panel');
    const promptPanel = document.getElementById('prompt-panel');
    const panelsEl    = document.getElementById('panels');
    let dragging = false;

    handle.addEventListener('mousedown', e => { dragging = true; handle.classList.add('dragging'); e.preventDefault(); });
    document.addEventListener('mousemove', e => {
      if (!dragging) { return; }
      const pct = Math.min(Math.max((e.clientX - panelsEl.getBoundingClientRect().left) / panelsEl.offsetWidth * 100, 25), 75);
      filePanel.style.flex   = '0 0 ' + pct + '%';
      promptPanel.style.flex = '0 0 ' + (100 - pct) + '%';
    });
    document.addEventListener('mouseup', () => { dragging = false; handle.classList.remove('dragging'); });

  })();
</script>
</body>
</html>`;
}

// Server-side HTML escaper; esc() in the webview script is its browser-side counterpart
function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
