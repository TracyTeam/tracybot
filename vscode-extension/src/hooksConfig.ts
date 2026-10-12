// Kept free of the 'vscode' module so it can be unit-tested directly.

export interface HookSpec {
  bunPath: string;
  scriptPath: string;
  postToolUseMatcher: string;
  // Omitted for agents whose plugin has no PreToolUse hook (Codex).
  preToolUseMatcher?: string;
}

function command(spec: HookSpec, event: string): string {
  return `${spec.bunPath} ${spec.scriptPath} ${event}`;
}

function findHookEntry(hookList: any[] | undefined, cmd: string): any | undefined {
  return (hookList ?? []).find((entry: any) => (entry.hooks ?? []).some((h: any) => h.command === cmd));
}

// Adds the entry, or just brings an existing one's matcher up to date.
function upsertMatcherHook(config: any, event: string, cmd: string, matcher: string): void {
  config.hooks[event] ??= [];
  const existing = findHookEntry(config.hooks[event], cmd);
  if (existing) {
    existing.matcher = matcher;
  } else {
    config.hooks[event].push({ matcher, hooks: [{ type: 'command', command: cmd }] });
  }
}

// Checks every hook applyHooks() manages — checking only one would report
// "already configured" (and skip forever) even if another were missing, e.g.
// a user manually removed just that one, or an install from before a hook or
// a matcher entry existed. Matchers are compared too, so such an install gets
// updated rather than skipped.
export function isHooksConfigCurrent(config: any, spec: HookSpec): boolean {
  if (!config?.hooks) { return false; }

  const postOk = findHookEntry(config.hooks.PostToolUse, command(spec, 'post-tool-use'))?.matcher === spec.postToolUseMatcher;
  const stopOk = findHookEntry(config.hooks.Stop, command(spec, 'stop')) !== undefined;
  const preOk = spec.preToolUseMatcher === undefined
    || findHookEntry(config.hooks.PreToolUse, command(spec, 'pre-tool-use'))?.matcher === spec.preToolUseMatcher;

  return postOk && stopOk && preOk;
}

// Merges into the existing hooks config rather than replacing it, and is
// idempotent — mirrors each plugin's own scripts/deploy.js.
export function applyHooks(config: any, spec: HookSpec): void {
  config.hooks ??= {};

  upsertMatcherHook(config, 'PostToolUse', command(spec, 'post-tool-use'), spec.postToolUseMatcher);

  if (spec.preToolUseMatcher !== undefined) {
    upsertMatcherHook(config, 'PreToolUse', command(spec, 'pre-tool-use'), spec.preToolUseMatcher);
  }

  config.hooks.Stop ??= [];
  const stopCommand = command(spec, 'stop');
  if (!findHookEntry(config.hooks.Stop, stopCommand)) {
    config.hooks.Stop.push({ hooks: [{ type: 'command', command: stopCommand }] });
  }
}
