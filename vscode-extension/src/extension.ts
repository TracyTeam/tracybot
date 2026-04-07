import * as vscode from 'vscode';

import { getMockHistory } from './history/mockHistory';
import { getContiguousChunks } from './utils';
import { getPromptPanelHtml } from './promptPanel';
import { buildHistory } from './history/buildHistory';
import { openTaskletMenu } from './taskletMenu';

// Transform MockData into the shape extension.ts works with, adding selected state
type Entry = { lines: number[]; message: string; prompt: string; model: string; selected: boolean };
type FileEntries = Record<string, Entry[]>;

// Build the initial FileEntries structure from the mock data, and setting selected attribute to false for all entries
function buildFileEntries(): FileEntries {
  const data = getMockHistory();
  const result: FileEntries = {};

  for (const file of data.files) {
    result[file.path] = file.tasklets.map(tasklet => ({
      lines: tasklet.lines,
      message: tasklet.name,
      prompt: tasklet.prompt,
      model: tasklet.model,
      selected: false,
    }));
  }

  return result;
}

// TODO: remove this once integrated with the workspace
const TEST_HISTORY_BUILDER = true;
if (TEST_HISTORY_BUILDER) {
  buildHistory(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath).then(history => {
    console.log(history);
  });
}

// Mutable at runtime so toggleAiBlame can update selected state
const mockData: FileEntries = buildFileEntries();

// Tracks whether "AI blame mode" is currently active
let aiBlameModeActive = false;

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

    // Get the file name and corresponding entries from mock data, exit if no entries
    const fileName = document.fileName.split(/[\\/]/).pop() || '';
    const entries = mockData[fileName];
    if (!entries) { return []; }

    // Get the active editor and ensure it's the same document, exit if not
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== document.uri.toString()) { return []; }

    // Use the cursor anchor (head) position, ignoring selection range
    const cursorLine = editor.selection.active.line;

    // Find the entry the cursor is currently on
    const entryUnderCursor = entries.find(e => e.lines.includes(cursorLine));
    if (!entryUnderCursor) { return []; }

    // Split the entry's lines into contiguous chunks and find which one the cursor is in
    const chunks = getContiguousChunks(entryUnderCursor.lines);
    const chunkUnderCursor = chunks.find(chunk => chunk.includes(cursorLine));
    if (!chunkUnderCursor) { return []; }

    // Show the CodeLens above the first line of the chunk the cursor is in
    const firstLineOfChunk = chunkUnderCursor[0];
    const range = new vscode.Range(firstLineOfChunk, 0, firstLineOfChunk, 0);

    return [
      new vscode.CodeLens(range, {
        title: `AI blame: ${entryUnderCursor.message}`,
        // Opens the prompt panel when clicked, passing the entry's prompt
        command: 'tracybot-extension.openPromptPanel',
        arguments: [entryUnderCursor.prompt, entryUnderCursor.message, entryUnderCursor.model, entryUnderCursor.lines],
        tooltip: `Click to view prompt for "${entryUnderCursor.message}"`,
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
    vscode.window.onDidChangeTextEditorSelection(() => {
      if (aiBlameModeActive) {
        // Update highlighted entry based on new cursor position, then refresh UI
        updateActiveSelection();
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
        // Leaving AI blame mode — clear all selections
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          const fileName = editor.document.fileName.split(/[\\/]/).pop() || '';
          const entries = mockData[fileName];
          if (entries) { entries.forEach(e => e.selected = false); }
        }
        updateDecorations();
      }

      // Update status bar and CodeLens to reflect new mode state
      updateStatusBar();
      codeLensProvider.refresh();
    })
  );

  // Register command to open a prompt panel with the entry's prompt
  context.subscriptions.push(
    vscode.commands.registerCommand('tracybot-extension.openPromptPanel', (prompt: string, message: string, model: string, lines: number[]) => {
      // Create and show a webview panel to display the prompt

      const editor = vscode.window.activeTextEditor;
      const fileName = editor?.document.fileName.split(/[\\/]/).pop() || '';

      const panel = vscode.window.createWebviewPanel(
        'tracybotPrompt',
        message,
        vscode.ViewColumn.Beside,
        {enableScripts: true}
      );

      panel.webview.onDidReceiveMessage(
        msg => {
          console.log("received message", msg);
          if (msg.command === 'openTaskletMenu') {
            
            const entries = mockData[fileName];
            if (!entries) {
              console.log("No entries for", fileName);
              return;
            }
            const taskletNames = entries.map(e => e.message);

            panel.webview.html = openTaskletMenu(taskletNames);
          }

          if (msg.command === 'openTasklet') {
            const entries = mockData[fileName];
            if (!entries) { return; }

            const entry = entries[msg.index];

            panel.webview.html = getPromptPanelHtml(
              entry.prompt,
              entry.message,
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
    vscode.window.onDidChangeActiveTextEditor(() => {
      if (aiBlameModeActive) {
        updateActiveSelection();
        codeLensProvider.refresh();
      } else {
        updateDecorations();
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(() => updateDecorations())
  );

  updateDecorations();
}

// Updates which entry is "selected" based on the current cursor position
// Only called when AI blame mode is active
function updateActiveSelection() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return; }

  // Use cursor anchor position, ignoring any selection range
  const cursorLine = editor.selection.active.line;
  const fileName = editor.document.fileName.split(/[\\/]/).pop() || '';
  const entries = mockData[fileName];
  if (!entries) { return; }

  // Deselect all, then select only the entry under the cursor
  entries.forEach(e => e.selected = false);
  const entryUnderCursor = entries.find(e => e.lines.includes(cursorLine));
  if (entryUnderCursor) {
    entryUnderCursor.selected = true;
  }

  updateDecorations();
}

function updateDecorations() {
  // Get the active editor and its file name, exit if there's no active editor
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return; }

  // Get the file name and corresponding entries from mock data, exit if no entries
  const fileName = editor.document.fileName.split(/[\\/]/).pop() || '';
  const entries = mockData[fileName];

  // If there are no entries for this file, clear all decorations and exit
  if (!entries) {
    editor.setDecorations(gutterUnselectedDecoration, []);
    editor.setDecorations(gutterSelectedDecoration, []);
    editor.setDecorations(unselectedAIDecoration, []);
    editor.setDecorations(selectedAIDecoration, []);
    return;
  }

  const lineCount = editor.document.lineCount;

  // Filter out invalid line numbers and entries with no valid lines
  const validEntries = entries.map(entry => ({
    ...entry,
    lines: entry.lines.filter(line => line >= 0 && line < lineCount)
  })).filter(entry => entry.lines.length > 0);

  // Gutter icon on every line of unselected records
  const unselectedGutterRanges = validEntries
    .filter(e => !e.selected)
    .flatMap(e => e.lines.map(line => ({
      range: new vscode.Range(line, 0, line, 0),
    })));
  editor.setDecorations(gutterUnselectedDecoration, unselectedGutterRanges);

  // Gutter icon on every line of selected records
  const selectedGutterRanges = validEntries
    .filter(e => e.selected)
    .flatMap(e => e.lines.map(line => ({
      range: new vscode.Range(line, 0, line, 0),
    })));
  editor.setDecorations(gutterSelectedDecoration, selectedGutterRanges);

  // Background highlight for unselected records
  const unselectedRanges = validEntries
    .filter(e => !e.selected)
    .flatMap(e => e.lines.map(line =>
      new vscode.Range(line, 0, line, editor.document.lineAt(line).text.length)
    ));
  editor.setDecorations(unselectedAIDecoration, unselectedRanges);

  // Background highlight for selected records
  const selectedRanges = validEntries
    .filter(e => e.selected)
    .flatMap(e => e.lines.map(line =>
      new vscode.Range(line, 0, line, editor.document.lineAt(line).text.length)
    ));
  editor.setDecorations(selectedAIDecoration, selectedRanges);
}

export function deactivate() { }