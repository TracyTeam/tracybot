import type { Memento } from 'vscode';
import { TaskletResearchPayload } from './types';

// Subset of vscode.Memento's shape — lets this module be unit-tested with a
// plain in-memory mock, no real 'vscode' module needed at runtime or in tests.
export interface KeyValueStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void> | void;
}

const PENDING_PAYLOADS_KEY = 'tracybot.researchMode.pendingPayloads';
const DAILY_DIGEST_KEY = 'tracybot.researchMode.dailyDigest';
const QUEUED_TASKLET_IDS_KEY = 'tracybot.researchMode.queuedTaskletIds';

interface DailyDigest {
  date: string; // YYYY-MM-DD
  count: number;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isTaskletQueued(store: KeyValueStore, taskletId: string): boolean {
  return store.get<string[]>(QUEUED_TASKLET_IDS_KEY, []).includes(taskletId);
}

async function markTaskletQueued(store: KeyValueStore, taskletId: string): Promise<void> {
  const ids = store.get<string[]>(QUEUED_TASKLET_IDS_KEY, []);
  if (!ids.includes(taskletId)) {
    await store.update(QUEUED_TASKLET_IDS_KEY, [...ids, taskletId]);
  }
}

// Appends the payload to the local pending queue and bumps today's digest
// count. This is the seam Task 4 will replace — swapping the storage/send
// step for the real private-repo backend — without the caller needing to
// change. Idempotent: queueing an already-queued Tasklet is a no-op, so
// callers don't need to track dedup themselves.
export async function queueTaskletForSubmission(store: KeyValueStore, payload: TaskletResearchPayload): Promise<void> {
  if (isTaskletQueued(store, payload.tasklet_id)) {
    return;
  }

  const pending = store.get<TaskletResearchPayload[]>(PENDING_PAYLOADS_KEY, []);
  await store.update(PENDING_PAYLOADS_KEY, [...pending, payload]);

  const digest = store.get<DailyDigest>(DAILY_DIGEST_KEY, { date: todayIso(), count: 0 });
  const today = todayIso();
  const nextCount = digest.date === today ? digest.count + 1 : 1;
  await store.update(DAILY_DIGEST_KEY, { date: today, count: nextCount } satisfies DailyDigest);

  await markTaskletQueued(store, payload.tasklet_id);
}

export function getTodaysSentCount(store: KeyValueStore): number {
  const digest = store.get<DailyDigest>(DAILY_DIGEST_KEY, { date: todayIso(), count: 0 });
  return digest.date === todayIso() ? digest.count : 0;
}

export function getPendingPayloads(store: KeyValueStore): TaskletResearchPayload[] {
  return store.get<TaskletResearchPayload[]>(PENDING_PAYLOADS_KEY, []);
}

// Removes successfully-submitted Tasklets from the pending queue. Leaves
// QUEUED_TASKLET_IDS_KEY untouched — that list is the permanent dedup record,
// so a Tasklet already sent is never re-queued even after it's cleared here.
export async function clearPendingPayloads(store: KeyValueStore, sentTaskletIds: string[]): Promise<void> {
  if (sentTaskletIds.length === 0) {
    return;
  }

  const sentIds = new Set(sentTaskletIds);
  const remaining = getPendingPayloads(store).filter(p => !sentIds.has(p.tasklet_id));
  await store.update(PENDING_PAYLOADS_KEY, remaining);
}
