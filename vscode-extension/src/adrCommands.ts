import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { History } from './history/types';
import { buildAdr, defaultTitle } from './adr/buildAdr';
import { listAdrFiles, resolveAdrDir } from './adr/files';
import { writeAdrFile } from './adr/write';
import { refreshAdrStatus } from './adr/refresh';
import { taskletKey } from './adr/status';

// The repository is passed in, never looked up here: by the time a button is
// clicked the active editor is a webview, and getRepoPath() would fall back to
// the first repository of a multi-repo workspace.
function adrDirectory(repoPath: string | undefined): { repoPath: string; dir: string } | undefined {
  if (!repoPath) {
    vscode.window.showInformationMessage('Tracybot: open a folder inside a git repository first.');
    return undefined;
  }

  const setting = vscode.workspace.getConfiguration('tracybot').get<string>('adrDirectory');
  const dir = resolveAdrDir(repoPath, setting);
  if (!dir) {
    vscode.window.showErrorMessage('Tracybot: the "tracybot.adrDirectory" setting must be a folder inside the repository (not outside it, and not a link that leads outside).');
    return undefined;
  }
  return { repoPath, dir };
}

// Backs the "Create ADR" button on an AI Blame tasklet card. `history` and
// `repoPath` are the ones the AI Blame panel was opened with; `snapshotId` is
// the id the card is keyed by in the webview.
export async function createAdrFromTasklet(history: History | undefined, repoPath: string | undefined, snapshotId: string): Promise<void> {
  const card = history?.files.flatMap(f => f.tasklets).find(t => t.id === snapshotId);
  if (!history || !card) {
    vscode.window.showErrorMessage('Tracybot: could not find that tasklet any more. Reopen AI Blame and try again.');
    return;
  }

  const target = adrDirectory(repoPath);
  if (!target) { return; }

  // The title is the one thing the tool can't guess well (it is the user's
  // request, which is often "yes" or a one-word instruction), so ask for it.
  const title = await vscode.window.showInputBox({
    title: 'Create ADR',
    prompt: 'Title of the decision',
    value: defaultTitle(card, card.agentSource),
    ignoreFocusOut: true,
    validateInput: value => (value.trim() === '' ? 'A title is required' : undefined),
  });
  if (title === undefined) { return; }

  const key = taskletKey(card);
  const draft = buildAdr(history, key, { title });
  if (!draft) {
    vscode.window.showErrorMessage('Tracybot: could not build an ADR for that tasklet.');
    return;
  }

  let written: string;
  try {
    written = writeAdrFile(target.dir, draft.title, key, draft.markdown);
  } catch (err) {
    vscode.window.showErrorMessage(`Tracybot: could not write the ADR: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(written)));
  vscode.window.showInformationMessage(
    `Tracybot: created ${path.relative(target.repoPath, written)} (status: ${draft.status.status}). Fill in the TODO sections, then commit it.`
  );
}

// Re-computes the status of every Tracybot ADR in the ADR folder. `history`
// must be freshly built.
export async function refreshAdrStatuses(history: History | undefined, repoPath: string | undefined): Promise<void> {
  if (!history) {
    vscode.window.showErrorMessage('Tracybot: could not read the AI history for this repository.');
    return;
  }

  const target = adrDirectory(repoPath);
  if (!target) { return; }

  const files = listAdrFiles(target.dir);
  if (files.length === 0) {
    vscode.window.showInformationMessage(`Tracybot: no ADRs found in ${path.relative(target.repoPath, target.dir)}.`);
    return;
  }

  const dirty = new Set(vscode.workspace.textDocuments.filter(d => d.isDirty).map(d => d.uri.fsPath));
  const now = new Date();
  const tally = { updated: 0, unchanged: 0, manual: 0, missing: 0, unsaved: 0 };

  for (const file of files) {
    // Writing under an open, edited buffer would make VS Code report a conflict on the next save.
    if (dirty.has(file)) { tally.unsaved++; continue; }

    const outcome = refreshAdrStatus(fs.readFileSync(file, 'utf8'), history, now);
    if (outcome.kind === 'ok') {
      if (outcome.changed) {
        fs.writeFileSync(file, outcome.markdown);
        tally.updated++;
      } else {
        tally.unchanged++;
      }
    } else if (outcome.kind === 'manual-status') {
      tally.manual++;
    } else if (outcome.kind === 'tasklet-missing') {
      tally.missing++;
    }
  }

  const notes = [
    tally.manual > 0 ? `${tally.manual} skipped (status set by hand)` : '',
    tally.missing > 0 ? `${tally.missing} whose tasklet is no longer in the history` : '',
    tally.unsaved > 0 ? `${tally.unsaved} skipped (unsaved changes in the editor)` : '',
  ].filter(Boolean);
  vscode.window.showInformationMessage(
    `Tracybot: ADR status refreshed: ${tally.updated} updated, ${tally.unchanged} unchanged${notes.length > 0 ? `, ${notes.join(', ')}` : ''}.`
  );
}
