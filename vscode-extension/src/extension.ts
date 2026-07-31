import * as vscode from 'vscode';

import { buildHistory, hydrateCache, getSerializedCache, clearCache } from './history/buildHistory';
import { History, TaskletUI, LineMap, Change } from './history/types';
import { getBlameViewHtml } from './blameView';
import { getRepoPath, mergeRemoteNotes } from './utils';
import { checkOpencode } from './pluginCheck';
import { checkHookBasedAgents } from './hookAgentPluginCheck';
import { checkTracyInit } from './tracyInitCheck';
import { checkResearchModeConsent } from './research/researchModeCheck';
import { getConsentTier, getParticipantContext, isResearchModeEnabled } from './research/consent';
import { clearPendingPayloads, getPendingPayloads, getTodaysSentCount, queueTaskletForSubmission } from './research/queue';
import { buildTaskletResearchPayloads } from './research/buildResearchPayloads';
import { submitPayloads } from './research/collectorRepo';

// History data — populated asynchronously when the extension activates
let history: History | undefined;
let buildHistoryLock: Promise<void> | null = null;

// Maps a relative file path to a map of line number -> Tasklet
// Built once after history loads; updated on each blameAI invocation
let lineMap: LineMap = new Map();
let displayLineMap: LineMap = new Map();
// Per-file, all tasklets (including those whose live lines have been fully
// overridden but that still have ghost attribution at some current-tree line).
let fileTaskletsMap: Map<string, TaskletUI[]> = new Map();

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

function buildFileTaskletsMap(h: typeof history & {}): Map<string, TaskletUI[]> {
  const result = new Map<string, TaskletUI[]>();
  for (const file of h.files) {
    result.set(file.path, file.tasklets as TaskletUI[]);
  }
  return result;
}

async function buildHistoryAndSet(ctx: vscode.ExtensionContext): Promise<void> {
  if (buildHistoryLock) {
    console.log('buildHistory already running, waiting...');
    await buildHistoryLock;

    return;
  }

  const repoPath = await getRepoPath();
  if (!repoPath) {
    return;
  }

  buildHistoryLock = (async () => {
    const time = Date.now();

    try {
      const result = await buildHistory(repoPath);
      console.log(`History build time: ${Date.now() - time}ms`);

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
      fileTaskletsMap = buildFileTaskletsMap(history);

      await ctx.workspaceState.update('tracybot.buildHistoryCache', getSerializedCache());
      await processNewTaskletsForResearch(ctx, result);
    } finally {
      buildHistoryLock = null;
    }
  })();

  await buildHistoryLock;
}

// Status bar item showing today's Research Mode digest — only visible when enabled
let researchStatusBarItem: vscode.StatusBarItem;

function updateResearchStatusBar(ctx: vscode.ExtensionContext): void {
  if (!isResearchModeEnabled()) {
    researchStatusBarItem.hide();
    return;
  }

  const count = getTodaysSentCount(ctx.globalState);
  const label = `Sent ${count} tasklet${count === 1 ? '' : 's'} today`;
  researchStatusBarItem.text = `$(cloud-upload) ${label}`;
  researchStatusBarItem.tooltip = `${label} — click to review`;
  researchStatusBarItem.show();
}

// Builds a research payload for every Tasklet in the freshly-built history and
// queues it locally (queueTaskletForSubmission is idempotent per taskletId, so
// re-running this on every history rebuild is safe). Then makes a best-effort
// attempt to push everything pending to the collector repo — failures (no
// network, no token configured yet, push rejected) just leave the queue as-is
// for the next history rebuild to retry, so this is safe to call often.
async function processNewTaskletsForResearch(ctx: vscode.ExtensionContext, h: History): Promise<void> {
  if (!isResearchModeEnabled()) { return; }

  const participant = getParticipantContext(ctx);
  const payloads = buildTaskletResearchPayloads(h, getConsentTier(), participant);

  for (const payload of payloads) {
    await queueTaskletForSubmission(ctx.globalState, payload);
  }

  await trySubmitPendingPayloads(ctx);
  updateResearchStatusBar(ctx);
}

async function trySubmitPendingPayloads(ctx: vscode.ExtensionContext): Promise<void> {
  const pending = getPendingPayloads(ctx.globalState);
  if (pending.length === 0) { return; }

  try {
    const sentIds = await submitPayloads(pending);
    await clearPendingPayloads(ctx.globalState, sentIds);
  } catch (err) {
    console.error('Tracybot Research Mode: failed to submit pending payloads, will retry later.', err);
  }
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

// Agent detection (checkOpencode/checkHookBasedAgents) only runs on
// activation or opening a new repo, so an agent installed mid-session (VS
// Code windows often stay open for days) wouldn't be picked up until the
// next reload. This re-runs the same idempotent checks once a day for
// windows that stay open that long, without polling any more often than that.
const AGENT_RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Activate function
export async function activate(context: vscode.ExtensionContext) {
  // git extension is a hard requirement for some functions
  const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
  if (!gitExtension) {
    return undefined;
  }

  const git = gitExtension.getAPI(1);
  if (!git) {
    return undefined;
  }

  const runInitialChecks = () => {
    checkTracyInit(context);
    checkOpencode(context);
    checkHookBasedAgents(context);
    checkResearchModeConsent(context);
  };

  runInitialChecks();

  const agentRecheckTimer = setInterval(() => {
    checkOpencode(context);
    checkHookBasedAgents(context);
  }, AGENT_RECHECK_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(agentRecheckTimer) });

  // Status bar button — always visible, click opens the blame panel
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'tracybot-extension.blameAI';
  statusBarItem.text = '$(git-commit) AI Blame';
  statusBarItem.tooltip = 'Open AI Blame view for the current file';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Research Mode digest — only visible once the participant has opted in
  researchStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  researchStatusBarItem.command = 'tracybot-extension.reviewResearchDigest';
  context.subscriptions.push(researchStatusBarItem);
  updateResearchStatusBar(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('tracybot-extension.reviewResearchDigest', async () => {
      const count = getTodaysSentCount(context.globalState);
      const pending = getPendingPayloads(context.globalState);

      const action = await vscode.window.showInformationMessage(
        `Tracybot Research Mode: sent ${count} tasklet${count === 1 ? '' : 's'} today. ` +
        `${pending.length} total pending.`,
        'View Pending Data',
        'Disable Research Mode'
      );

      if (action === 'View Pending Data') {
        const doc = await vscode.workspace.openTextDocument({
          content: JSON.stringify(pending, null, 2),
          language: 'json',
        });
        await vscode.window.showTextDocument(doc);
      } else if (action === 'Disable Research Mode') {
        await vscode.workspace.getConfiguration('tracybot.researchMode')
          .update('enabled', false, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('Tracybot Research Mode disabled.');
        updateResearchStatusBar(context);
      }
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('tracybot.researchMode.enabled')) {
        updateResearchStatusBar(context);
      }
    })
  );

  // get cache from the workspaceState
  hydrateCache(context.workspaceState.get<Record<string, Change[]>>('tracybot.buildHistoryCache'));

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

      const saved = await document.save();
      if (!saved) {
        vscode.window.showWarningMessage('AI Blame: Could not save file. Results may be inaccurate.');
      }

      // Rebuild history fresh on every invocation
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: `AI Blame: loading history for ${fileName}…`,
          cancellable: false,
        },
        async () => {
          await buildHistoryAndSet(context);
        }
      );

      if (!history) {
        vscode.window.showErrorMessage('AI Blame: Failed to build history.');
        return;
      }

      // Resolve the (now-fresh) file map for the active document.
      const fileMap: Map<number, TaskletUI> | undefined =
        getDisplayLineMapForDocument(document) ??
        (() => {
          const relativePath = getDocumentRelativePath(document);
          return relativePath ? lineMap.get(relativePath) : undefined;
        })();

      const relativePath = getDocumentRelativePath(document);
      const fileTasklets = relativePath ? (fileTaskletsMap.get(relativePath) ?? []) : [];

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
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
        }
      );

      panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');

      const initialLine = editor.selection.active.line;
      panel.webview.html = getBlameViewHtml(fileContent, fileName, fileMap, fileTasklets, panel.webview, context.extensionUri, initialLine);
    })
  );

  const refreshHistory = () => {
    if (git.repositories.length > 0) {
      buildHistoryAndSet(context);
    }
  };

  // Runs on any git state change (commits, checkouts, staging, autofetch, ...):
  // merges remote notes, then rebuilds history so a commit — the natural
  // "this AI edit is now finalized" signal — triggers Research Mode's
  // queue-and-submit without the user having to click AI Blame or reopen the
  // project first.
  const syncNotesOnStateChange = async () => {
    const repoPath = await getRepoPath();
    if (repoPath) {
      await mergeRemoteNotes(repoPath);
    }
    refreshHistory();
  };

  // clearCache — clears the history cache
  context.subscriptions.push(
    vscode.commands.registerCommand('tracybot-extension.invalidateCache', async () => {
      clearCache();

      await context.workspaceState.update('tracybot.buildHistoryCache', undefined);
      vscode.window.showInformationMessage('Tracybot: History cache cleared.');

      refreshHistory();
    })
  );

  // Warm up history on activation so the first blameAI click is faster
  refreshHistory();
  context.subscriptions.push(
    git.onDidOpenRepository(() => {
      runInitialChecks();
      refreshHistory();
    }),
    // Merge remote notes after git state changes (covers autofetch completing)
    ...git.repositories.map((repo: { state: { onDidChange: (cb: () => void) => vscode.Disposable } }) =>
      repo.state.onDidChange(syncNotesOnStateChange)
    )
  );
}

export function deactivate() { }
