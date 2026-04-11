import * as vscode from 'vscode';

import { buildHistory } from './history/buildHistory';
import { History, TaskletUI, LineMap } from './history/types';
import { getBlameViewHtml } from './blameView';

// History data — populated asynchronously when the extension activates
let history: History | undefined;

// Maps a relative file path to a map of line number -> Tasklet
// Built once after history loads; updated on each blameAI invocation
let lineMap: LineMap = new Map();
let displayLineMap: LineMap = new Map();

// Builds the lineMap from the loaded history
function buildLineMap(h: typeof history & {}): LineMap {
  const result: LineMap = new Map();

  for (const file of h.files) {
    const fileMap = new Map<number, TaskletUI>();

    for (const tasklet of file.tasklets as TaskletUI[]) {
      for (const line of tasklet.lines) {
        // - 1 because VS Code line numbers are 0-based but our history is 1-based
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

  const fullPath = document.uri.fsPath.replace(/\\/g, '/');
  const rootPath = workspaceRoot.replace(/\\/g, '/');

  return fullPath.startsWith(rootPath)
    ? fullPath.slice(rootPath.length).replace(/^\//, '')
    : undefined;
}

// Returns the line->tasklet map for a given document from the display map
function getDisplayLineMapForDocument(document: vscode.TextDocument): Map<number, TaskletUI> | undefined {
  if (!displayLineMap.size) { return undefined; }
  const relativePath = getDocumentRelativePath(document);
  if (!relativePath) { return undefined; }
  return displayLineMap.get(relativePath);
}

// Status bar item that opens the blame panel when clicked
let statusBarItem: vscode.StatusBarItem;

// Activate function
export function activate(context: vscode.ExtensionContext) {
  // Status bar button — always visible, click opens the blame panel
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'tracybot-extension.blameAI';
  statusBarItem.text = '$(git-commit) AI Blame';
  statusBarItem.tooltip = 'Open AI Blame view for the current file';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // blameAI — rebuilds history fresh then opens the read-only blame panel
  context.subscriptions.push(
    vscode.commands.registerCommand('tracybot-extension.blameAI', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('AI Blame: No active editor.');
        return;
      }
      if (editor.document.uri.scheme !== 'file') {
        vscode.window.showWarningMessage('AI Blame: Not a file editor.');
        return;
      }

      const document = editor.document;
      const fileName = document.fileName.split(/[\\/]/).pop() ?? document.fileName;

      // Snapshot file content immediately before the async work so the webview
      // reflects exactly what the user sees at the moment they clicked.
      const fileContent = document.getText();

      // Rebuild history fresh on every invocation
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: `AI Blame: loading history for ${fileName}…`,
          cancellable: false,
        },
        async () => {
          const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const result = await buildHistory(workspaceRoot);

          if (!result) {
            vscode.window.showErrorMessage('AI Blame: Failed to build history.');
            return;
          }

          // Extend each tasklet with the runtime 'selected' flag and store globally
          result.files.forEach(file =>
            file.tasklets.forEach(t => (t as TaskletUI).selected = false)
          );

          history = result as unknown as { files: { path: string; tasklets: TaskletUI[] }[] } & History;

          lineMap = buildLineMap(history);
          displayLineMap = new Map(lineMap);
        }
      );

      // Resolve the (now-fresh) file map for the active document.
      const fileMap: Map<number, TaskletUI> | undefined =
        getDisplayLineMapForDocument(document) ??
        (() => {
          const relativePath = getDocumentRelativePath(document);
          return relativePath ? lineMap.get(relativePath) : undefined;
        })();

      if (!fileMap || fileMap.size === 0) {
        vscode.window.showInformationMessage(
          `AI Blame: No AI-generated lines found in "${fileName}".`
        );
        return;
      }

      // Open the blame webview in the full editor group. Using ViewColumn.Active
      // keeps it in the same column; retainContextWhenHidden preserves scroll
      // and selection state across tab switches.
      const panel = vscode.window.createWebviewPanel(
        'tracybotBlameView',
        `AI Blame — ${fileName}`,
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        }
      );

      panel.webview.html = getBlameViewHtml(fileContent, fileName, fileMap);
    })
  );

  // Warm up history on activation so the first blameAI click is faster
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const time = Date.now();
  buildHistory(workspaceRoot).then(async (result) => {
    console.log(`History build time: ${Date.now() - time}ms`);
    console.log(result);

    if (!result) {
      console.error('Failed to build history');
      return;
    }

    result.files.forEach(file =>
      file.tasklets.forEach(t => (t as TaskletUI).selected = false)
    );

    history = result as unknown as { files: { path: string; tasklets: TaskletUI[] }[] } & History;

    lineMap = buildLineMap(history);
    displayLineMap = new Map(lineMap);
  });
}

export function deactivate() { }
