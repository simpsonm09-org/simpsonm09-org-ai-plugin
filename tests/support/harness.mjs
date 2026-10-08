// Drive each harness the way its host does, in-process. The OpenCode plugin is set up with a
// stub context and its create.before callback is called with the input the shell hook gets;
// the Claude hook handler is called with the PreToolUse JSON the hook reads from stdin. The
// token is the fixture's literal, and nothing here runs the command the hook returns.

import { join } from "node:path";

/**
 * Set up an OpenCode plugin with a stub context and return its create.before callback.
 * @param {{ setup: (ctx: any) => Promise<void> }} plugin
 * @param {{ workspaceRoot?: string, scripts?: { access?: string, token?: string } }} [options]
 * @returns {Promise<(input: any) => Promise<void>>}
 */
export async function openCodeHook(plugin, options = {}) {
  const hooks = new Map();
  const ctx = {
    skill: {
      transform: async (callback) => {
        callback({ get: () => undefined, remove() {}, add() {} });
        return { dispose: async () => {} };
      },
    },
    shell: {
      hook: async (name, callback) => {
        hooks.set(name, callback);
        return { dispose: async () => {} };
      },
    },
    session: {
      hook: async (name, callback) => {
        hooks.set(`session:${name}`, callback);
        return { dispose: async () => {} };
      },
    },
    location: { directory: options.workspaceRoot ?? process.cwd() },
    options,
  };
  await plugin.setup(ctx);
  const before = hooks.get("create.before");
  if (!before) throw new Error("the plugin registered no create.before hook");
  return before;
}

/**
 * Run one command through the OpenCode callback. The result is the command text and the
 * environment the shell would receive, and the action read from them.
 * @param {(input: any) => Promise<void>} hook
 * @param {{ command: string, cwd: string, shell?: string }} call
 * @param {string} originalCommand
 * @returns {Promise<{ command: string, env: Record<string, string> | null, action: "pass" | "deny" | "inject" }>}
 */
export async function runOpenCode(hook, call, originalCommand = call.command) {
  const input = {
    command: call.command,
    cwd: call.cwd,
    ...(call.shell ? { shell: call.shell } : {}),
  };
  await hook(input);
  const env = input.env === undefined ? null : { ...input.env };
  const action = env?.GH_TOKEN
    ? "inject"
    : input.command !== originalCommand
      ? "deny"
      : "pass";
  return { command: input.command, env, action };
}

/**
 * Run one PreToolUse call through the Claude handler and map its answer.
 * @param {(input: any, options: any) => Promise<any>} handler
 * @param {{ tool: "Bash" | "PowerShell", cwd: string, command: string }} call
 * @param {{ workspaceRoot: string, env?: Record<string, string | undefined> }} options
 * @returns {Promise<{ action: "pass" | "deny" | "inject", permission?: "allow" | "ask", reason?: string, output: any }>}
 */
export async function runClaude(handler, call, options) {
  const output = await handler(
    {
      tool_name: call.tool,
      cwd: call.cwd,
      tool_input: { command: call.command, description: "parity" },
    },
    options,
  );
  if (!output) return { action: "pass", output };
  const hook = output.hookSpecificOutput;
  if (hook.permissionDecision === "deny")
    return { action: "deny", reason: hook.permissionDecisionReason, output };
  return {
    action: "inject",
    permission: hook.permissionDecision,
    reason: hook.permissionDecisionReason,
    output,
  };
}

/**
 * The absolute cwd for a cell's relative path.
 * @param {string} workspace
 * @param {string} relative
 * @returns {string}
 */
export function cwdFor(workspace, relative) {
  return join(workspace, ...relative.split("/"));
}
