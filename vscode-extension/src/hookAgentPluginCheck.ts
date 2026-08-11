import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { spawn, execSync } from 'child_process';
import { clearFailureCooldown, notifyFailureOnce } from './failureCooldown';
import { getBunInstallCommand } from './bunInstall';

// Claude Code and Codex both install via merging a hooks config JSON (unlike
// OpenCode's single-file-drop plugin — see pluginCheck.ts), so this is one
// generic, parameterized checker/installer for both rather than duplicated
// per-agent logic.
interface HookAgentConfig {
  id: string;
  displayName: string;
  cliCommand: string;
  hooksConfigPath: string;
  hookScriptFilename: string;
  installDir: string;
  postToolUseMatcher: string;
  failureCooldownKey: string;
}

const AGENTS: HookAgentConfig[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    cliCommand: 'claude',
    hooksConfigPath: path.join(homedir(), '.claude', 'settings.json'),
    hookScriptFilename: 'tracybot-cc-hook.js',
    installDir: path.join(homedir(), '.claude', 'tracybot'),
    postToolUseMatcher: 'Edit|Write|MultiEdit',
    failureCooldownKey: 'tracybot.claudeCodeInstallFailureAt',
  },
  {
    id: 'codex',
    displayName: 'Codex CLI',
    cliCommand: 'codex',
    hooksConfigPath: path.join(homedir(), '.codex', 'hooks.json'),
    hookScriptFilename: 'tracybot-codex-hook.js',
    installDir: path.join(homedir(), '.codex', 'tracybot'),
    postToolUseMatcher: 'apply_patch|Edit|Write',
    failureCooldownKey: 'tracybot.codexInstallFailureAt',
  },
];

function findCli(command: string): Promise<boolean> {
  return new Promise(resolve => {
    const proc = spawn(command, ['--version'], { stdio: 'ignore' });
    proc.on('close', code => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

// Same rationale as the plugin packages' own deploy.js: a hook's execution
// environment isn't guaranteed to have the same PATH as an interactive
// shell, so an absolute path is resolved once here and baked into the hook
// command rather than relying on a bare `bun` at hook-run time.
function resolveBunPath(): string | undefined {
  try {
    return execSync('command -v bun', { encoding: 'utf8' }).trim();
  } catch {
    const fallback = path.join(homedir(), '.bun', 'bin', 'bun');
    return fs.existsSync(fallback) ? fallback : undefined;
  }
}

// Runs Bun's own official installer in a visible integrated terminal — not a
// silent background process — so the user sees the script's own output and
// it runs in their normal shell environment, matching how they'd run it
// themselves. Deliberately doesn't try to detect completion or auto-reverify:
// the terminal is async/interactive, and checkHookBasedAgents already
// re-checks on every activation/repo-open, so the next one picks it up on
// its own once Bun is actually installed — no extra wiring needed here.
function installBun(): void {
  const terminal = vscode.window.createTerminal('Install Bun');
  terminal.sendText(getBunInstallCommand());
  terminal.show();
}

// undefined = file doesn't exist yet (fine, starts empty).
// null = file exists but isn't valid JSON (caller must not overwrite it).
function loadHooksConfig(configPath: string): any {
  if (!fs.existsSync(configPath)) { return {}; }
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

function hasHookCommand(hookList: any[] | undefined, command: string): boolean {
  return (hookList ?? []).some((entry: any) => (entry.hooks ?? []).some((h: any) => h.command === command));
}

// Checks both hooks installHooks() manages — checking only PostToolUse would
// report "already configured" (and skip forever) even if Stop were somehow
// missing, e.g. a user manually edited the config and removed just that one.
function isAlreadyConfigured(agent: HookAgentConfig, scriptPath: string, bunPath: string): boolean {
  const config = loadHooksConfig(agent.hooksConfigPath);
  if (!config?.hooks) { return false; }
  return hasHookCommand(config.hooks.PostToolUse, `${bunPath} ${scriptPath} post-tool-use`)
    && hasHookCommand(config.hooks.Stop, `${bunPath} ${scriptPath} stop`);
}

async function downloadHookScript(agent: HookAgentConfig): Promise<string> {
  const destPath = path.join(agent.installDir, agent.hookScriptFilename);
  fs.mkdirSync(agent.installDir, { recursive: true });

  const url = `https://github.com/TracyTeam/tracybot/releases/latest/download/${agent.hookScriptFilename}`;
  const response = await fetch(url);
  if (!response.ok) { throw new Error(`Plugin download failed: (${response.status})`); }

  fs.writeFileSync(destPath, Buffer.from(await response.arrayBuffer()));
  return destPath;
}

// Merges into any existing hooks config rather than overwriting it — mirrors
// each plugin's own scripts/deploy.js exactly, so a user who later runs that
// script manually (e.g. for development) sees the same idempotent behavior.
function installHooks(agent: HookAgentConfig, scriptPath: string, bunPath: string): void {
  const config = loadHooksConfig(agent.hooksConfigPath);
  if (config === null) {
    throw new Error(`${agent.hooksConfigPath} exists but isn't valid JSON — fix or remove it, then try again.`);
  }

  config.hooks ??= {};

  config.hooks.PostToolUse ??= [];
  const postToolUseCommand = `${bunPath} ${scriptPath} post-tool-use`;
  if (!hasHookCommand(config.hooks.PostToolUse, postToolUseCommand)) {
    config.hooks.PostToolUse.push({
      matcher: agent.postToolUseMatcher,
      hooks: [{ type: 'command', command: postToolUseCommand }],
    });
  }

  config.hooks.Stop ??= [];
  const stopCommand = `${bunPath} ${scriptPath} stop`;
  if (!hasHookCommand(config.hooks.Stop, stopCommand)) {
    config.hooks.Stop.push({ hooks: [{ type: 'command', command: stopCommand }] });
  }

  fs.mkdirSync(path.dirname(agent.hooksConfigPath), { recursive: true });
  fs.writeFileSync(agent.hooksConfigPath, JSON.stringify(config, null, 2) + '\n');
}

// No confirmation prompt — installing Tracybot is itself the user's opt-in to
// AI change tracing (that's the extension's whole stated purpose), so asking
// again per detected agent is redundant friction, not extra consent. This
// only wires up local, on-device tracking (hidden git commits) — nothing
// leaves the machine from this step alone; that's what Research Mode's own,
// separately-gated consent flow is for. Still surfaces a non-blocking
// notification after installing, so the user isn't left unaware of what
// just happened, and an error notification if it fails — neither requires a
// click to dismiss or to proceed.
async function checkAgent(context: vscode.ExtensionContext, agent: HookAgentConfig): Promise<void> {
  const scriptPath = path.join(agent.installDir, agent.hookScriptFilename);
  const existingBunPath = resolveBunPath();
  if (existingBunPath && fs.existsSync(scriptPath) && isAlreadyConfigured(agent, scriptPath, existingBunPath)) {
    await clearFailureCooldown(context.globalState, agent.failureCooldownKey);
    return;
  }

  if (!existingBunPath) {
    await notifyFailureOnce(context.globalState, agent.failureCooldownKey, async () => {
      const action = await vscode.window.showErrorMessage(
        `Failed to install Tracybot ${agent.displayName} plugin: Bun is required to run this plugin.`,
        'Install Bun'
      );
      if (action === 'Install Bun') { installBun(); }
    });
    return;
  }

  try {
    const installedScriptPath = await downloadHookScript(agent);
    installHooks(agent, installedScriptPath, existingBunPath);

    await clearFailureCooldown(context.globalState, agent.failureCooldownKey);
    vscode.window.showInformationMessage(`Tracybot: ${agent.displayName} plugin installed.`);
  } catch (error) {
    await notifyFailureOnce(context.globalState, agent.failureCooldownKey, () => {
      vscode.window.showErrorMessage(
        `Failed to install Tracybot ${agent.displayName} plugin: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }
}

// Exported so pluginCheck.ts's OpenCode-specific "no supported agent found"
// fallback can check these two before showing that message — otherwise a
// Claude Code- or Codex-only user (no OpenCode) would incorrectly be told
// they have no supported agent at all.
export async function detectAnyHookAgent(): Promise<boolean> {
  const results = await Promise.all(AGENTS.map(agent => findCli(agent.cliCommand)));
  return results.some(Boolean);
}

export async function checkHookBasedAgents(context: vscode.ExtensionContext): Promise<void> {
  for (const agent of AGENTS) {
    const available = await findCli(agent.cliCommand);
    if (!available) { continue; }

    await checkAgent(context, agent);
  }
}
