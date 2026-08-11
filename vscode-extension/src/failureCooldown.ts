// Subset of vscode.Memento's shape — same convention as research/queue.ts's
// KeyValueStore — lets this module be unit-tested with a plain in-memory
// fake, no real 'vscode' module needed at runtime or in tests.
export interface CooldownStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | void;
}

// A failed attempt (missing dependency, flaky network, ...) shouldn't be
// reshown on every single activation — that would spam a notification the
// user can't act on immediately. But the cooldown must NEVER gate the check
// or the attempt itself, only the repeat *notification* — otherwise a user
// who fixes the problem (installs Bun, network comes back) doesn't get
// picked up again for up to 24h, even across reloads, since this is backed
// by globalState.
export const FAILURE_RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Clears any stored cooldown for `key`. Call this on every success path
// (including "already fine, nothing to do") so a later, unrelated failure
// doesn't inherit a stale suppression window from an old, now-resolved one.
export async function clearFailureCooldown(store: CooldownStore, key: string): Promise<void> {
  await store.update(key, undefined);
}

// Runs `notify` only if the same failure hasn't already been shown to the
// user within the cooldown window, then records "shown" now. Callers must
// have already re-run their full check/attempt before calling this — this
// function only throttles the notification, nothing else.
export async function notifyFailureOnce(
  store: CooldownStore,
  key: string,
  notify: () => Promise<void> | void
): Promise<void> {
  const lastShownAt = store.get<number>(key);
  if (lastShownAt && Date.now() - lastShownAt < FAILURE_RETRY_COOLDOWN_MS) {
    return;
  }
  await store.update(key, Date.now());
  await notify();
}
