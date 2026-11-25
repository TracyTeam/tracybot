import * as fs from 'fs';
import * as path from 'path';
import type { CooldownStore } from './failureCooldown';

// The OpenCode plugin is a single file dropped into OpenCode's plugin dir, so
// nothing else updates it: an "exists, so we're done" check left users on
// whatever plugin they first installed, even after an extension update that
// shipped a plugin fix (e.g. the OpenCode 2.x plugin API change). The plugin
// and extension are released together from one tag, so the extension
// version that last synced the file is recorded, and a different extension
// version re-syncs it.
export const SYNCED_VERSION_KEY = 'tracybot.opencodePluginSyncedVersion';

const RELEASES = 'https://github.com/TracyTeam/tracybot/releases';

// The asset from this extension's own release, so plugin and extension match.
// `latest` is the fallback for builds whose version has no release yet (a
// locally packaged extension, or a release still being published).
export function pluginUrlsFor(filename: string, extensionVersion: string): string[] {
  return [
    `${RELEASES}/download/v${extensionVersion}/${filename}`,
    `${RELEASES}/latest/download/${filename}`,
  ];
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

async function download(urls: string[], fetchFn: FetchLike): Promise<Buffer> {
  let lastStatus = 0;
  for (const url of urls) {
    const response = await fetchFn(url);
    if (response.ok) { return Buffer.from(await response.arrayBuffer()); }
    lastStatus = response.status;
  }
  throw new Error(`Plugin download failed: (${lastStatus})`);
}

export function isSyncedFor(destPath: string, extensionVersion: string, store: CooldownStore): boolean {
  return fs.existsSync(destPath) && store.get<string>(SYNCED_VERSION_KEY) === extensionVersion;
}

export type SyncResult = 'installed' | 'updated' | 'unchanged';

// Downloads the plugin and writes it to `destPath` only if its content differs,
// then records `extensionVersion` as synced. Writes go through a temp file and
// a rename, so an OpenCode starting mid-update never loads a truncated plugin.
export async function syncPluginFile(
  destPath: string,
  extensionVersion: string,
  store: CooldownStore,
  fetchFn: FetchLike,
): Promise<SyncResult> {
  const content = await download(pluginUrlsFor(path.basename(destPath), extensionVersion), fetchFn);

  const existed = fs.existsSync(destPath);
  let result: SyncResult = existed ? 'updated' : 'installed';
  if (existed && fs.readFileSync(destPath).equals(content)) {
    result = 'unchanged';
  } else {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const tmpPath = `${destPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, destPath);
  }

  await store.update(SYNCED_VERSION_KEY, extensionVersion);
  return result;
}
