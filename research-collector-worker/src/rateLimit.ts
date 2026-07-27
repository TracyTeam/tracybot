// Generous on purpose — real participants submitting their own Tasklets will
// never come close. This exists only to cap the blast radius if the (public,
// by design — see collectorRepo.ts on the extension side) submit key gets
// used for abuse rather than legitimate submissions.
const DAILY_LIMIT = 500;

// KV entries expire after 2 days, comfortably past the UTC day boundary this
// key is scoped to, so stale counters don't accumulate.
const KEY_TTL_SECONDS = 172800;

function todayKey(participantId: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `ratelimit:${participantId}:${today}`;
}

// Returns true if the batch fits within today's remaining quota, and records
// the increment. Returns false (without recording anything) if it would
// exceed the limit — the whole batch is rejected rather than partially
// admitted, so the caller doesn't have to reconcile which payloads "count".
export async function tryConsumeRateLimit(
  kv: KVNamespace,
  participantId: string,
  count: number
): Promise<boolean> {
  const key = todayKey(participantId);
  const current = await kv.get(key);
  const used = current ? parseInt(current, 10) : 0;

  if (used + count > DAILY_LIMIT) {
    return false;
  }

  await kv.put(key, String(used + count), { expirationTtl: KEY_TTL_SECONDS });
  return true;
}
