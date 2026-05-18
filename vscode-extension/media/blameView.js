(function () {
  'use strict';

  // LINES, LINE_MAP, LINE_PREVIOUS, TASKLETS, FILE_NAME, INITIAL_LINE
  // are injected as globals by blameView.ts

  let selectedTaskletId = null;
  let selectedLine = null;

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
    const cl = document.body.classList;
    const isLight = cl.contains('vscode-light') || cl.contains('vscode-high-contrast-light');
    return HLJS_CDN + (isLight ? 'atom-one-light.min.css' : 'atom-one-dark.min.css');
  }

  function applyHljsTheme() {
    document.getElementById('hljs-theme').href = getHljsThemeUrl();
  }

  new MutationObserver(applyHljsTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  applyHljsTheme();

  function getLanguage(name) {
    const ext = name.split('.').pop().toLowerCase();
    return hljs.getLanguage(ext) ? ext : null;
  }

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

  // ── Selection state ───────────────────────────────────────────────────────

  function handleLineClick(lineIdx) {
    const ownerId = LINE_MAP[String(lineIdx)];
    if (ownerId === undefined) { return; }

    // Toggle off if clicking the already-selected line of the same tasklet.
    if (selectedLine === lineIdx && selectedTaskletId === ownerId) {
      selectedLine = null;
      selectedTaskletId = null;
      clearSelection();
      showBlank();
      return;
    }

    // Clicking any AI line always switches focus to that line's live owner.
    // Previous tasklets that ghost-overlap with this line do not absorb the
    // click — the dropdown is the only way to reach them.
    selectedTaskletId = ownerId;
    selectedLine = lineIdx;
    applySelection(selectedTaskletId);
    showPrompt(selectedTaskletId);
  }

  function clearSelection() {
    document.querySelectorAll('tr.ai-selected, tr.ai-line-cursor')
      .forEach(tr => tr.classList.remove('ai-selected', 'ai-line-cursor'));
  }

  function applySelection(taskletId) {
    clearSelection();
    const t = TASKLETS[taskletId];
    if (!t) { return; }

    // Highlight only live (currently owned) lines. Ghost lines — the
    // tasklet's overridden positions — are intentionally NOT decorated:
    // their current visual owner is the live tasklet that overrode them
    // (or, if the override was a significant user edit, they are plain
    // text and must remain unhighlighted).
    t.lines.forEach(li => {
      const tr = tbody.querySelector(`tr[data-line="${li}"]`);
      if (tr) { tr.classList.add('ai-selected'); }
    });

    if (selectedLine !== null) {
      const tr = tbody.querySelector(`tr[data-line="${selectedLine}"]`);
      if (tr) { tr.classList.add('ai-line-cursor'); }
    }
  }

  const promptContent = document.getElementById('prompt-content');

  // Auto-select initial line
  if (INITIAL_LINE !== null) {
    const taskletId = LINE_MAP[String(INITIAL_LINE)];
    if (taskletId !== undefined) {
      selectedTaskletId = taskletId;
      selectedLine = INITIAL_LINE;
      applySelection(taskletId);
      showPrompt(taskletId);
    }
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

  function previousTaskletIdsForLine(lineIdx) {
    if (lineIdx === null || lineIdx === undefined) { return []; }
    return LINE_PREVIOUS[String(lineIdx)] || [];
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
              <div class="message-label ${esc(msg.stage)}">${esc(msg.stage)} · ${esc(msg.type)}${msg.type === 'response' && msg.model ? ` · ${esc(msg.model)}` : ''}</div>
              <div class="message-box ${esc(msg.type)} ${esc(msg.stage)}">${renderMd(msg.message)}</div>
              ${questionsHtml ? `<div class="questions-section">${questionsHtml}</div>` : ''}
            </div>`;
        }).join('')
      : `<div class="message-box prompt build"><p><em>No messages recorded for this tasklet.</em></p></div>`;

    const linesCount = t.lines.length;
    const linesPill = linesCount > 0
      ? `<span class="meta-pill">${linesCount}&nbsp;line${linesCount !== 1 ? 's' : ''}</span>`
      : '';

    const prevIds = previousTaskletIdsForLine(selectedLine);
    const prevDropdownHtml = (selectedLine !== null && prevIds.length > 0)
      ? `
        <div class="previous-tasklets">
          <div class="section-label">Previous tasklets for line ${selectedLine + 1}</div>
          <details class="prev-dropdown">
            <summary>${prevIds.length} previous tasklet${prevIds.length !== 1 ? 's' : ''} touched this line</summary>
            <ul class="prev-tasklet-list">
              ${prevIds.map(id => {
                const pt = TASKLETS[id];
                if (!pt) { return ''; }
                return `<li class="prev-tasklet-item" data-id="${esc(id)}">
                  <span class="prev-name">${esc(pt.name)}</span>
                  <span class="prev-meta">${esc(pt.model)}</span>
                </li>`;
              }).join('')}
            </ul>
          </details>
        </div>`
      : '';

    promptContent.innerHTML = `
      <div class="tasklet-card">
        <div class="card-nav">
          <div class="card-title">${esc(t.name)}</div>
          <button class="menu-btn" id="all-tasklets-btn">All Tasklets</button>
        </div>
        <div class="card-nav-pills">
          <span class="meta-pill accent">${esc(t.model)}</span>
          ${t.originCommitHash ? `<span class="commit-chip" title="${esc(t.originCommitHash)}">${esc(t.originCommitHash.slice(0, 8))}</span>` : ''}
          ${linesPill}
        </div>

        <div class="section-label">Messages</div>
        <div class="messages-section">${messagesHtml}</div>

        ${t.chunks.length > 0 ? `
        <div class="lines-section">
          <div class="section-label">Chunks</div>
          <div class="lines-chips">${chunkChips}</div>
        </div>` : ''}

        ${prevDropdownHtml}
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
      selectedLine = null;
    });

    promptContent.querySelectorAll('.prev-tasklet-item').forEach(li => {
      li.addEventListener('click', () => {
        selectPreviousTasklet(li.dataset.id);
      });
    });
  }

  function selectPreviousTasklet(taskletId) {
    const t = TASKLETS[taskletId];
    if (!t || t.lines.length === 0) { return; }

    selectedTaskletId = taskletId;

    // Move the selected line to the live line of this tasklet nearest the
    // current selection; this is what the user sees as "the cursor jumped
    // to a surviving piece of this tasklet's work."
    let nextLine = t.lines[0];
    if (selectedLine !== null) {
      let bestDelta = Infinity;
      for (const li of t.lines) {
        const delta = Math.abs(li - selectedLine);
        if (delta < bestDelta) { bestDelta = delta; nextLine = li; }
      }
    }
    selectedLine = nextLine;

    applySelection(selectedTaskletId);
    showPrompt(selectedTaskletId);

    const tr = tbody.querySelector(`tr[data-line="${selectedLine}"]`);
    if (tr) { tr.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }

  // ── Tasklet menu ──────────────────────────────────────────────────────────
  // Only tasklets that still own at least one live line are listed; fully
  // overridden tasklets are only reachable via the per-line previous-tasklets
  // dropdown.
  function liveTaskletList() {
    return Object.values(TASKLETS).filter(t => t.lines.length > 0);
  }

  function showTaskletMenu() {
    const items = liveTaskletList()
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
        const t = TASKLETS[id];
        selectedTaskletId = id;
        // Move the line cursor onto this tasklet's first live line so the
        // previous-tasklets dropdown reflects this tasklet's context.
        selectedLine = t && t.lines.length > 0 ? t.lines[0] : null;
        applySelection(id);
        const first = tbody.querySelector('tr.ai-line-cursor') || tbody.querySelector('tr.ai-selected');
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
