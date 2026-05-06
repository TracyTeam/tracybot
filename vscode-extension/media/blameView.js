(function () {
  'use strict';

  // LINES, LINE_MAP, TASKLETS, FILE_NAME, INITIAL_LINE are injected as globals by blameView.ts

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

  // ── Syntax highlighting ───────────────────────────────────────────────────

  const HLJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/';

  function getHljsThemeUrl() {
    const isLight = document.body.classList.contains('vscode-light');
    return HLJS_CDN + (isLight ? 'atom-one-light.min.css' : 'atom-one-dark.min.css');
  }

  function applyHljsTheme() {
    document.getElementById('hljs-theme').href = getHljsThemeUrl();
  }

  // Re-apply theme whenever VS Code switches between light/dark/high-contrast
  new MutationObserver(applyHljsTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  applyHljsTheme();

  function getLanguage(name) {
    const ext = name.split('.').pop().toLowerCase();
    return hljs.getLanguage(ext) ? ext : null;
  }

  // Split highlight.js HTML output into per-line strings, preserving open spans across newlines
  function splitHighlightedHtml(html) {
    const rawLines = html.split('\n');
    const result = [];
    let openTags = [];

    for (const rawLine of rawLines) {
      const lineHtml = openTags.join('') + rawLine;

      const stack = [];
      const tagRe = /<span[^>]*>|<\/span>/g;
      let m;
      while ((m = tagRe.exec(lineHtml)) !== null) {
        if (m[0].startsWith('</')) { stack.pop(); }
        else { stack.push(m[0]); }
      }

      openTags = stack.slice();
      result.push(lineHtml + '</span>'.repeat(stack.length));
    }

    return result;
  }

  function applyHighlighting() {
    if (typeof hljs === 'undefined') { return; }
    const lang = getLanguage(FILE_NAME);
    const fullCode = LINES.join('\n');

    let highlighted;
    try {
      highlighted = lang
        ? hljs.highlight(fullCode, { language: lang, ignoreIllegals: true }).value
        : hljs.highlightAuto(fullCode).value;
    } catch (_) { return; }

    const highlightedLines = splitHighlightedHtml(highlighted);
    const tds = tbody.querySelectorAll('td.line-code');
    tds.forEach((td, i) => {
      if (highlightedLines[i] !== undefined) {
        td.innerHTML = highlightedLines[i];
      }
    });
  }

  applyHighlighting();

  // ── Line selection ────────────────────────────────────────────────────────

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
      const tr = tbody.querySelector(`tr[data-line="${li}"]`);
      if (tr) { tr.classList.add('ai-selected'); }
    });
  }

  const promptContent = document.getElementById('prompt-content');

  // Auto-select initial line
  if (INITIAL_LINE !== null) {

    // If the line is part of the tasklet, select the whole tasklet and show its prompt
    const taskletId = LINE_MAP[String(INITIAL_LINE)];
    if (taskletId !== undefined) {
      selectedTaskletId = taskletId;
      applySelection(taskletId);
      showPrompt(taskletId);
    }

    // In any case (even if there is no tasklet assosiated with the selected line), scroll the line into view
    const tr = tbody.querySelector(`tr[data-line="${INITIAL_LINE}"]`);
    if (tr) { tr.scrollIntoView({ block: 'center', behavior: 'instant' }); }
  }

  function showBlank() {
    promptContent.innerHTML = `
      <div id="blank-state">
        <svg class="hint-icon" viewBox="0 0 24 24" fill="none">
          <path d="M15 15l6 6M10 17a7 7 0 1 1 0-14 7 7 0 0 1 0 14z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <p>Click a highlighted line to view its prompt</p>
      </div>`;
  }

  function renderMd(text) {
    if (!text) { return ''; }
    return (typeof marked !== 'undefined') ? marked.parse(text, { breaks: true }) : `<p>${esc(text)}</p>`;
  }

  function showPrompt(taskletId) {
    const t = TASKLETS[taskletId];
    if (!t) { return; }

    const chunkChips = t.chunks.map(chunk => {
      const first = chunk[0];
      const last  = chunk[chunk.length - 1];
      const label = first === last ? `${first + 1}` : `${first + 1}–${last + 1}`;
      return `<span class="line-chip" data-first="${first}" data-last="${last}">${label}</span>`;
    }).join('');

    const messagesHtml = (t.messages && t.messages.length > 0)
      ? t.messages.map(msg => {
          const questionsHtml = (msg.questions && msg.questions.length > 0)
            ? msg.questions.map(q => `
                <div class="question-item">
                  <div class="question-header">${esc(q.header)}</div>
                  <div class="question-text">${esc(q.question)}</div>
                </div>
              `).join('')
            : '';
          return `
            <div>
              <div class="message-label ${esc(msg.stage)}">${esc(msg.stage)} · ${esc(msg.type)}</div>
              <div class="message-box ${esc(msg.type)} ${esc(msg.stage)}">${renderMd(msg.message)}</div>
              ${questionsHtml ? `<div class="questions-section">${questionsHtml}</div>` : ''}
            </div>`;
        }).join('')
      : `<div class="message-box prompt build"><p><em>No messages recorded for this tasklet.</em></p></div>`;

    promptContent.innerHTML = `
      <div class="tasklet-card">
        <div class="card-nav">
          <div class="card-title">${esc(t.name)}</div>
          <span class="meta-pill accent">${esc(t.model)}</span>
          <span class="meta-pill">${t.lines.length}&nbsp;line${t.lines.length !== 1 ? 's' : ''}</span>
          <button class="menu-btn" id="all-tasklets-btn">All Tasklets</button>
        </div>

        <div class="section-label">Messages</div>
        <div class="messages-section">${messagesHtml}</div>

        <div class="lines-section">
          <div class="section-label">Chunks</div>
          <div class="lines-chips">${chunkChips}</div>
        </div>
      </div>`;

    promptContent.querySelectorAll('.line-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const firstLine = parseInt(chip.dataset.first, 10);
        const lastLine  = parseInt(chip.dataset.last,  10);
        const firstTr = tbody.querySelector(`tr[data-line="${firstLine}"]`);
        const lastTr  = tbody.querySelector(`tr[data-line="${lastLine}"]`);
        if (firstTr) { firstTr.scrollIntoView({ block: 'start',   behavior: 'smooth' }); }
        if (lastTr)  { lastTr.scrollIntoView({  block: 'nearest', behavior: 'smooth' }); }
      });
    });

    document.getElementById('all-tasklets-btn').addEventListener('click', () => {
      showTaskletMenu();
      clearSelection();
      selectedTaskletId = null;
    });
  }

  // ── Tasklet menu ──────────────────────────────────────────────────────────
  const TASKLET_LIST = Object.values(TASKLETS);

  function showTaskletMenu() {
    const items = TASKLET_LIST
      .map(t => `<li data-id="${esc(t.id)}">${esc(t.name)}</li>`)
      .join('');

    promptContent.innerHTML = `
      <div class="tasklet-menu">
        <div class="menu-title">All Tasklets</div>
        <ul class="tasklet-list">${items}</ul>
      </div>`;

    promptContent.querySelectorAll('.tasklet-list li').forEach(li => {
      li.addEventListener('click', () => {
        const id = li.dataset.id;
        selectedTaskletId = id;
        applySelection(id);
        const first = tbody.querySelector('tr.ai-selected');
        // Scroll to the first line of the selected tasklet
        if (first) { first.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
        showPrompt(id);
      });
    });
  }

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
