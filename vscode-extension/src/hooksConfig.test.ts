import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { applyHooks, isHooksConfigCurrent, HookSpec } from "./hooksConfig";

const CLAUDE: HookSpec = {
  bunPath: "/bun",
  scriptPath: "/home/u/.claude/tracybot/tracybot-cc-hook.js",
  postToolUseMatcher: "Edit|Write|MultiEdit|Bash",
  preToolUseMatcher: "Bash",
};
const CODEX: HookSpec = {
  bunPath: "/bun",
  scriptPath: "/home/u/.codex/tracybot/tracybot-codex-hook.js",
  postToolUseMatcher: "apply_patch|Edit|Write",
};

const cmd = (spec: HookSpec, event: string) => `${spec.bunPath} ${spec.scriptPath} ${event}`;

// What an install from before the PreToolUse hook existed looks like on disk.
function installBeforePreToolUse(): any {
  return {
    hooks: {
      PostToolUse: [{ matcher: "Edit|Write|MultiEdit|Bash", hooks: [{ type: "command", command: cmd(CLAUDE, "post-tool-use") }] }],
      Stop: [{ hooks: [{ type: "command", command: cmd(CLAUDE, "stop") }] }],
    },
  };
}

describe("hooksConfig", () => {
  test("a fresh config gets PostToolUse, PreToolUse (Bash) and Stop", () => {
    const config: any = {};
    applyHooks(config, CLAUDE);

    assert.equal(config.hooks.PostToolUse[0].matcher, "Edit|Write|MultiEdit|Bash");
    assert.equal(config.hooks.PreToolUse[0].matcher, "Bash");
    assert.equal(config.hooks.PreToolUse[0].hooks[0].command, cmd(CLAUDE, "pre-tool-use"));
    assert.equal(config.hooks.Stop[0].hooks[0].command, cmd(CLAUDE, "stop"));
    assert.equal(isHooksConfigCurrent(config, CLAUDE), true);
  });

  test("an install from before the PreToolUse hook is reported out of date, then upgraded in place", () => {
    const config = installBeforePreToolUse();
    assert.equal(isHooksConfigCurrent(config, CLAUDE), false);

    applyHooks(config, CLAUDE);

    assert.equal(isHooksConfigCurrent(config, CLAUDE), true);
    assert.equal(config.hooks.PostToolUse.length, 1, "PostToolUse must not be duplicated");
    assert.equal(config.hooks.Stop.length, 1, "Stop must not be duplicated");
    assert.equal(config.hooks.PreToolUse.length, 1);
  });

  test("a PreToolUse entry with the wrong matcher is corrected, not duplicated", () => {
    const config = installBeforePreToolUse();
    config.hooks.PreToolUse = [{ matcher: "Edit", hooks: [{ type: "command", command: cmd(CLAUDE, "pre-tool-use") }] }];
    assert.equal(isHooksConfigCurrent(config, CLAUDE), false);

    applyHooks(config, CLAUDE);

    assert.equal(config.hooks.PreToolUse.length, 1);
    assert.equal(config.hooks.PreToolUse[0].matcher, "Bash");
  });

  test("applying twice changes nothing the second time", () => {
    const config: any = {};
    applyHooks(config, CLAUDE);
    const once = JSON.stringify(config);
    applyHooks(config, CLAUDE);

    assert.equal(JSON.stringify(config), once);
  });

  test("the user's own hooks are left alone", () => {
    const config: any = {
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/my-guard" }] }],
        PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "prettier --write" }] }],
      },
      model: "opus",
    };
    applyHooks(config, CLAUDE);

    assert.equal(config.model, "opus");
    assert.equal(config.hooks.PreToolUse.length, 2);
    assert.equal(config.hooks.PreToolUse[0].hooks[0].command, "/usr/local/bin/my-guard");
    assert.equal(config.hooks.PostToolUse.length, 2);
    assert.equal(config.hooks.PostToolUse[0].hooks[0].command, "prettier --write");
  });

  test("an agent without a PreToolUse matcher (Codex) never gets one and isn't required to have one", () => {
    const config: any = {};
    applyHooks(config, CODEX);

    assert.equal(config.hooks.PreToolUse, undefined);
    assert.equal(isHooksConfigCurrent(config, CODEX), true);
  });

  test("a missing Stop hook makes the config out of date even if the others are present", () => {
    const config: any = {};
    applyHooks(config, CLAUDE);
    delete config.hooks.Stop;

    assert.equal(isHooksConfigCurrent(config, CLAUDE), false);
  });

  test("hooks pointing at a different script path don't count as this install", () => {
    const config: any = {};
    applyHooks(config, CLAUDE);

    assert.equal(isHooksConfigCurrent(config, { ...CLAUDE, scriptPath: "/elsewhere/tracybot-cc-hook.js" }), false);
  });

  test("no config at all is out of date", () => {
    assert.equal(isHooksConfigCurrent({}, CLAUDE), false);
    assert.equal(isHooksConfigCurrent(null, CLAUDE), false);
  });
});
