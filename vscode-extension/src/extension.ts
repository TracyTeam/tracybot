import * as vscode from 'vscode';

// temporary mock data for testing
const mockData: Record<string, { lines: number[]; message: string; selected: boolean }[]> = {
  "example.ts": [
    { lines: [0, 1, 2, 11], message: "Prompt 1", selected: false },
    { lines: [5, 6, 7], message: "Prompt 2", selected: false },
    { lines: [10], message: "Prompt 3", selected: false },
  ]
};

// Define decoration
let gutterUnselectedDecoration: vscode.TextEditorDecorationType;
let gutterSelectedDecoration: vscode.TextEditorDecorationType;
let unselectedAIDecoration: vscode.TextEditorDecorationType;
let selectedAIDecoration: vscode.TextEditorDecorationType;

// Activate function
export function activate(context: vscode.ExtensionContext) {
  // Register a hello world command for testing
  const disposable = vscode.commands.registerCommand('tracybot-extension.helloWorld', () => {
    vscode.window.showInformationMessage('Hello World from tracybot-extension!');
  });
  context.subscriptions.push(disposable);

  // Create text highlights
  unselectedAIDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(128, 0, 255, 0.20)',
  });

  selectedAIDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(128, 0, 255, 0.70)',
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

  // Register hover provider (temporary for testing)
  context.subscriptions.push(
    vscode.languages.registerHoverProvider('*', {
      provideHover(document, position) {
        const fileName = document.fileName.split(/[\\/]/).pop() || '';
        const entries = mockData[fileName];
        if (!entries) { return; }

        const entry = entries.find(e => e.lines.includes(position.line));
        if (!entry) { return; }

        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**Tracybot**\n\n${entry.message}`);
        return new vscode.Hover(markdown);
      }
    })
  );

  // Register command to toggle AI blame
  context.subscriptions.push(
    vscode.commands.registerCommand('tracybot-extension.toggleAiBlame', () => {
      const editor = vscode.window.activeTextEditor; // Get the active editor
      if (!editor) { return; } // No active editor, exit the command

      const cursorLine = editor.selection.active.line; // Get the current line number of the cursor
      const fileName = editor.document.fileName.split(/[\\/]/).pop() || ''; // Get the file name from the full path
      const entries = mockData[fileName]; // Get the mock data entries for the current file
      if (!entries) { return; } // No entries for this file, exit the command

      // Find the record that includes the current cursor line and check if it's already selected
      const recordUnderCursor = entries.find(e => e.lines.includes(cursorLine));
      const isAlreadySelected = recordUnderCursor?.selected ?? false;

      // Deselect all records
      entries.forEach(e => e.selected = false);

      // If the record under the cursor was not already selected, select it
      if (recordUnderCursor && !isAlreadySelected) {
        recordUnderCursor.selected = true;
      }

      // Update decorations to reflect the new selection state
      updateDecorations();
    })
  );

  // Register the command to toggle selection on active editor change and on document open
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => updateDecorations())
  );
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(() => updateDecorations())
  );

  // 
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
      hoverMessage: new vscode.MarkdownString(e.message),
    })));
  editor.setDecorations(gutterUnselectedDecoration, unselectedGutterRanges);

  // Gutter icon on every line of selected records
  const selectedGutterRanges = validEntries
    .filter(e => e.selected)
    .flatMap(e => e.lines.map(line => ({
      range: new vscode.Range(line, 0, line, 0),
      hoverMessage: new vscode.MarkdownString(e.message),
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