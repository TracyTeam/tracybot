import * as vscode from 'vscode';

import { getContiguousChunks } from './utils';
import { getPromptPanelHtml } from './promptPanel';
import { buildHistory } from './history/buildHistory';
import { openTaskletMenu } from './taskletMenu';
import { History, TaskletUI, LineMap } from './history/types';
import { getRepoPath, getLineDeltas, applyDiffToLineMap } from './utils';

// Tracks whether "AI blame mode" is currently active
let aiBlameModeActive = false;

// History data — populated asynchronously when the extension activates
let history: History | undefined;

// Maps a relative file path to a map of line number -> Tasklet
// Built once after history loads
// When lines overlap, the last tasklet to claim a line wins
let lineMap: LineMap = new Map();
let displayLineMap: LineMap = new Map(); // lineMap adjusted for user edits, used for decorations and CodeLens

// Builds the lineMap from the loaded history
// For every file in the history, create a map of line numbers to tasklets
function buildLineMap(h: typeof history & {}): LineMap {
  const result: LineMap = new Map();

  for (const file of h.files) {
    const fileMap = new Map<number, TaskletUI>();

    for (const tasklet of file.tasklets as TaskletUI[]) {
      for (const line of tasklet.lines) {
        // Newer tasklets are towards the end of the array, so last-write wins
        // correctly gives overlapping lines to the most recent tasklet
        // - 1 is needed because VS Code line numbers are 0-based but our history is 1-based
        fileMap.set(line - 1, tasklet);
      }
    }

    result.set(file.path, fileMap);
  }

  return result;
}



// Returns the relative path for a document, or undefined if outside the workspace
function getDocumentRelativePath(document: vscode.TextDocument): string | undefined {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { return undefined; }

  // Normalize separators to forward slashes for cross-platform comparison
  const fullPath = document.uri.fsPath.replace(/\\/g, '/');
  const rootPath = workspaceRoot.replace(/\\/g, '/');

  return fullPath.startsWith(rootPath)
    ? fullPath.slice(rootPath.length).replace(/^\//, '')
    : undefined;
}

// Returns the line->tasklet map for a given document, or undefined if not in history
function getDisplayLineMapForDocument(document: vscode.TextDocument): Map<number, TaskletUI> | undefined {
  if (!displayLineMap.size) { return undefined; }
  const relativePath = getDocumentRelativePath(document);
  if (!relativePath) { return undefined; }
  return displayLineMap.get(relativePath);
}

// Returns the unique tasklets for a document in their original order
// Used for decoration passes that need to iterate per-tasklet rather than per-line
function getUniqueTaskletsForDocument(document: vscode.TextDocument): TaskletUI[] | undefined {
  const map = getDisplayLineMapForDocument(document);
  if (!map) { return undefined; }

  // Deduplicate by reference — preserves original tasklet order
  const seen = new Set<TaskletUI>();
  for (const tasklet of map.values()) {
    seen.add(tasklet);
  }
  return [...seen];
}

// Define decorations
let gutterUnselectedDecoration: vscode.TextEditorDecorationType;
let gutterSelectedDecoration: vscode.TextEditorDecorationType;
let unselectedAIDecoration: vscode.TextEditorDecorationType;
let selectedAIDecoration: vscode.TextEditorDecorationType;

// Status bar item that shows the current AI blame mode state
let statusBarItem: vscode.StatusBarItem;

// Updates the status bar item appearance based on the current AI blame mode state
function updateStatusBar() {
  if (aiBlameModeActive) {
    statusBarItem.text = '$(eye) AI Blame';
    statusBarItem.tooltip = 'AI Blame mode is active — click to turn off';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    statusBarItem.text = '$(eye-closed) AI Blame';
    statusBarItem.tooltip = 'AI Blame mode is inactive — click to turn on';
    statusBarItem.backgroundColor = undefined;
  }
}

// CodeLens provider that shows ghost text above the current chunk when AI blame mode is active
class TracybotCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  // Call this to force VS Code to re-request code lenses (e.g. on cursor move)
  refresh() {
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    // Only show CodeLens when AI blame mode is active
    if (!aiBlameModeActive) { return []; }

    const map = getDisplayLineMapForDocument(document);
    if (!map) { return []; }

    // Get the active editor and ensure it's the same document, exit if not
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== document.uri.toString()) { return []; }

    // Use the cursor anchor (head) position, ignoring selection range
    const cursorLine = editor.selection.active.line;

    // Look up the tasklet at the cursor line directly
    const taskletUnderCursor = map.get(cursorLine);
    if (!taskletUnderCursor) { return []; }

    // Split the tasklet's lines into contiguous chunks and find which one the cursor is in
    const chunks = getContiguousChunks(taskletUnderCursor.lines);
    const chunkUnderCursor = chunks.find(chunk => chunk.includes(cursorLine));
    if (!chunkUnderCursor) { return []; }

    // Anchor the CodeLens above the first line of the chunk the cursor is in
    const firstLineOfChunk = chunkUnderCursor[0];
    const range = new vscode.Range(firstLineOfChunk, 0, firstLineOfChunk, 0);

    return [
      new vscode.CodeLens(range, {
        title: `AI blame: ${taskletUnderCursor.name}`,
        // Opens the prompt panel when clicked, passing the tasklet's prompt
        command: 'tracybot-extension.openPromptPanel',
        arguments: [taskletUnderCursor.prompt, taskletUnderCursor.name, taskletUnderCursor.model, taskletUnderCursor.lines],
        tooltip: `Click to view prompt for "${taskletUnderCursor.name}"`,
      })
    ];
  }
}

// Activate function
export function activate(context: vscode.ExtensionContext) {
  // Create text highlights
  unselectedAIDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(128, 0, 255, 0.20)',
  });

  selectedAIDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(128, 0, 255, 0.60)',
  });

  // Create gutter icons
  gutterUnselectedDecoration = vscode.window.createTextEditorDecorationType({
    gutterIconPath: context.asAbsolutePath('resources/icon.svg'),
    gutterIconSize: 'contain',
  });

  gutterSelectedDecoration = vscode.window.createTextEditorDecorationType({
    gutterIconPath: context.asAbsolutePath('resources/icon-selected.svg'),
    gutterIconSize: 'contain',
  });

  // Create the status bar item at the bottom, right-aligned, clicking it toggles AI blame mode
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'tracybot-extension.toggleAiBlame';
  updateStatusBar();
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Register the CodeLens provider and keep a reference so we can refresh it on cursor move
  const codeLensProvider = new TracybotCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider('*', codeLensProvider)
  );

  // Refresh CodeLens whenever the cursor moves so the ghost text follows the cursor
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(event => {
      // Ignore events from non-file editors (output panels, etc.)
      if (event.textEditor.document.uri.scheme !== 'file') { return; }
      if (aiBlameModeActive) {
        // Update highlighted entry based on new cursor position, then refresh UI
        updateActiveSelection();
        codeLensProvider.refresh();
      }
    })
  );

  // Watch for user edits and update the display lineMap in real time
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async document => {
      // Ignore non-file documents (output channels, git internals, etc.)
      if (document.uri.scheme !== 'file') { return; }

      const relativePath = getDocumentRelativePath(document);
      if (!relativePath) { return; }

      const fileMap = displayLineMap.get(relativePath);
      if (!fileMap) { return; } // file not in history — nothing to update

      const repoPath = await getRepoPath();
      if (!repoPath) { return; }

      // Get the line deltas for the entire repo, then apply them to just this file's line map
      const deltas = await getLineDeltas(repoPath);

      displayLineMap = applyDiffToLineMap(lineMap, deltas);

      // Redraw decorations and refresh CodeLens to reflect the updated map
      updateDecorations();
      if (aiBlameModeActive) {
        codeLensProvider.refresh();
      }
    })
  );

  // Register command to toggle AI blame mode on/off
  context.subscriptions.push(
    vscode.commands.registerCommand('tracybot-extension.toggleAiBlame', () => {
      aiBlameModeActive = !aiBlameModeActive;

      if (aiBlameModeActive) {
        // Entering AI blame mode — highlight whatever the cursor is already on
        updateActiveSelection();
      } else {
        // Leaving AI blame mode — clear all selections and decorations
        updateDecorations();
      }

      // Update status bar and CodeLens to reflect new mode state
      updateStatusBar();
      codeLensProvider.refresh();
    })
  );

  // Register command to open a prompt panel with the tasklet's prompt
  context.subscriptions.push(
    vscode.commands.registerCommand('tracybot-extension.openPromptPanel', (prompt: string, message: string, model: string, lines: number[]) => {
      // Create and show a webview panel to display the prompt

      const editor = vscode.window.activeTextEditor;
      const fileName = editor?.document.fileName.split(/[\\/]/).pop() || '';

      const panel = vscode.window.createWebviewPanel(
        'tracybotPrompt',
        message,
        vscode.ViewColumn.Beside,
        { enableScripts: true }
      );

      panel.webview.onDidReceiveMessage(
        msg => {
          console.log("received message", msg);
          if (msg.command === 'openTaskletMenu') {

            const entries = history?.files.find(f =>
              f.path.endsWith(fileName)
            )?.tasklets;

            if (!entries) {
              console.log("No entries for", fileName);
              return;
            }
            const taskletNames = entries.map(e => e.name);

            panel.webview.html = openTaskletMenu(taskletNames);
          }

          if (msg.command === 'openTasklet') {
            const entries = history?.files.find(f =>
              f.path.endsWith(fileName)
            )?.tasklets;

            if (!entries) { return; }

            const entry = entries[msg.index];

            panel.webview.html = getPromptPanelHtml(
              entry.prompt,
              entry.name,
              entry.model,
              entry.lines
            );
          }
        },
        undefined,
        context.subscriptions
      );

      panel.webview.html = getPromptPanelHtml(prompt, message, model, lines);
    })
  );

  // Re-apply decorations when switching files
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      // Ignore non-file editors
      if (!editor || editor.document.uri.scheme !== 'file') { return; }
      if (aiBlameModeActive) {
        updateActiveSelection();
        codeLensProvider.refresh();
      } else {
        updateDecorations();
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(document => {
      // Ignore non-file documents (output channels, git internals, etc.)
      if (document.uri.scheme !== 'file') { return; }
      updateDecorations();
    })
  );

  // Load history asynchronously then trigger an initial decoration pass
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  buildHistory(workspaceRoot).then(async (result) => {
    if (!result) {
      console.error('Failed to build history');
      return;
    }

    // Extend each tasklet with the runtime 'selected' flag
    result.files.forEach(file =>
      file.tasklets.forEach(t => (t as TaskletUI).selected = false)
    );

    history = result as unknown as { files: { path: string; tasklets: TaskletUI[] }[] } & History;
    console.log(`Tracybot: loaded history with ${history.files.length} files`);

    // Build the line map from the loaded history for fast per-line lookups
    lineMap = buildLineMap(history);

    // Get repo path
    const repoPath = await getRepoPath();
    if (!repoPath) { return; }

    // Apply latest line deltas on initial history load
    const deltas = await getLineDeltas(repoPath);
    displayLineMap = applyDiffToLineMap(lineMap, deltas);

    updateDecorations();
    codeLensProvider.refresh();
  });
}

// Updates which tasklet is "selected" based on the current cursor position
// Only called when AI blame mode is active — selection state drives highlight intensity
function updateActiveSelection() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return; }
  // Ignore non-file editors (output panels, etc.)
  if (editor.document.uri.scheme !== 'file') { return; }

  // Use cursor position only, ignoring any selection range
  const cursorLine = editor.selection.active.line;
  const map = getDisplayLineMapForDocument(editor.document);
  const tasklets = getUniqueTaskletsForDocument(editor.document);

  if (map && tasklets) {
    // Deselect all tasklets for this file
    tasklets.forEach(t => t.selected = false);

    // Select only the tasklet directly under the cursor
    const taskletUnderCursor = map.get(cursorLine);
    if (taskletUnderCursor) {
      taskletUnderCursor.selected = true;
    }
  }

  updateDecorations();
}

function updateDecorations() {
  // Get the active editor, exit if there's none
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return; }
  if (editor.document.uri.scheme !== 'file') { return; }

  const map = getDisplayLineMapForDocument(editor.document);

  // If there are no tasklets for this file, clear all decorations and exit
  if (!map) {
    editor.setDecorations(gutterUnselectedDecoration, []);
    editor.setDecorations(gutterSelectedDecoration, []);
    editor.setDecorations(unselectedAIDecoration, []);
    editor.setDecorations(selectedAIDecoration, []);
    return;
  }

  const lineCount = editor.document.lineCount;

  // Iterate over the line map directly — each line already resolves to one tasklet,
  // so overlaps are already resolved and no per-tasklet grouping is needed here
  const unselectedGutterRanges: vscode.DecorationOptions[] = [];
  const selectedGutterRanges: vscode.DecorationOptions[] = [];
  const unselectedRanges: vscode.Range[] = [];
  const selectedRanges: vscode.Range[] = [];

  for (const [line, tasklet] of map.entries()) {
    if (line < 0 || line >= lineCount) { continue; }

    // When AI blame mode is off, treat everything as unselected
    const isSelected = aiBlameModeActive && tasklet.selected;
    const gutterRange = { range: new vscode.Range(line, 0, line, 0) };
    const highlightRange = new vscode.Range(line, 0, line, editor.document.lineAt(line).text.length);

    if (isSelected) {
      selectedGutterRanges.push(gutterRange);
      selectedRanges.push(highlightRange);
    } else {
      unselectedGutterRanges.push(gutterRange);
      unselectedRanges.push(highlightRange);
    }
  }

  editor.setDecorations(gutterUnselectedDecoration, unselectedGutterRanges);
  editor.setDecorations(gutterSelectedDecoration, selectedGutterRanges);
  editor.setDecorations(unselectedAIDecoration, unselectedRanges);
  editor.setDecorations(selectedAIDecoration, selectedRanges);
}

export function deactivate() { }