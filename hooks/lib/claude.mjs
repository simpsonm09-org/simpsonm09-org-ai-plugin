// The Claude Code side of the agent-access gate. The decision is not made here: it is
// decideShell (gate.mjs), the same function the OpenCode plugin's gateShellEdit uses. This
// module maps that decision onto the hook protocol and adds the Claude-only rules that are
// not gate decisions: the launcher is not run as a program, a gh call asks unless it is a
// read, and a PowerShell gh call is refused with a hint.
//
// The workspace is the one this plugin is installed in (lib/location.mjs), never the
// working directory or the environment. A Bash or PowerShell call is gated; a denial is a
// PreToolUse deny; an allowed gh call is rewritten to run through the launcher, as "allow"
// for a read or "ask" for anything else. A call the hook cannot evaluate is a deny for a
// write and a pass for a read, and a malformed call is an error (exit 2) in the entry point.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultScripts,
  gitRemoteUrl,
  levelFor,
  loadAccessApi,
  resolveAccess,
} from "../../access.mjs";
import { encodePayload } from "../../bin/payload.mjs";
import {
  contextLine,
  decideShell,
  denyMessage,
  isWriteCommand,
  shellQuote,
} from "../../gate.mjs";
import { gitBashPath } from "../../lib/bash.mjs";
import {
  BudgetExhausted,
  clearBudget,
  PRE_TOOL_USE_BUDGET,
  startBudget,
} from "../../lib/budget.mjs";
import { fleetLookup } from "../../lib/fleet.mjs";
import { realPath, workspaceForPluginRoot } from "../../lib/location.mjs";
import { displayCommand, readOnlyGh, runsLauncher } from "./commands.mjs";

// hooks/lib/claude.mjs sits two levels below the plugin root.
export const PLUGIN_ROOT = realPath(
  resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."),
);
export const LAUNCHER = resolve(PLUGIN_ROOT, "bin", "with-gh-token.mjs");

// The tools the gate covers.
export const GATED_TOOLS = ["Bash", "PowerShell"];

/**
 * A PreToolUse deny. The reason is shown to Claude, and the call does not run.
 * @param {string} reason
 */
export function denyOutput(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

/**
 * A PreToolUse allow or ask that replaces the command. updatedInput keeps every other field.
 * @param {Record<string, unknown>} toolInput
 * @param {string} command
 * @param {string} reason
 * @param {"allow" | "ask"} permissionDecision
 */
export function rewriteOutput(toolInput, command, reason, permissionDecision) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason: reason,
      updatedInput: { ...toolInput, command },
    },
  };
}

/**
 * @param {string} text
 */
export function sessionContextOutput(text) {
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: text,
    },
  };
}

// A path written for bash: forward slashes, single-quoted.
/**
 * @param {string} path
 * @returns {string}
 */
function bashPathWord(path) {
  return shellQuote(path.replace(/\\/g, "/"));
}

// The command for an allowed gh call: node on the launcher with the payload as its only
// argument. The payload is base64, so this line is safe to quote.
/**
 * @param {{ workspace: string, repo: string, command: string }} payload
 * @param {string} [launcher]
 * @returns {string}
 */
export function launcherCommand(payload, launcher = LAUNCHER) {
  return `${bashPathWord(process.execPath)} ${bashPathWord(launcher)} ${shellQuote(encodePayload(payload))}`;
}

// The trusted workspace of this plugin, from its own location. A call may inject a workspace
// for tests (options.workspaceRoot); nothing else chooses it.
/**
 * @param {{ workspaceRoot?: string }} [options]
 * @returns {string | null}
 */
export function trustedWorkspace(options = {}) {
  if (
    typeof options.workspaceRoot === "string" &&
    options.workspaceRoot.length > 0
  )
    return resolve(options.workspaceRoot);
  return workspaceForPluginRoot(PLUGIN_ROOT);
}

// The reason shown with an allowed gh call: the repository, its level, and the command the
// human is approving.
/**
 * @param {{ repo: string | null, level: string }} decision
 * @param {string} command
 * @returns {string}
 */
function gitHubCallReason(decision, command) {
  return `${decision.repo} runs this gh command at level "${decision.level}" with a GitHub App token: ${displayCommand(command)}`;
}

// The parsed PreToolUse call. A call that is not an object, or that names a gated tool
// without a command string, is malformed: the entry point turns that into exit 2.
/**
 * @param {any} input
 * @returns {{ tool: string, command: string, toolInput: Record<string, unknown>, cwd: string | null, write: boolean } | null}
 */
function parseCall(input) {
  if (!input || typeof input !== "object")
    throw new Error("the hook input is not an object");
  const tool = input.tool_name;
  if (!GATED_TOOLS.includes(tool)) return null;
  const command = input.tool_input?.command;
  if (typeof command !== "string")
    throw new Error(`the ${tool} call has no command string`);
  const cwd =
    typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : null;
  return {
    tool,
    command,
    toolInput: input.tool_input,
    cwd,
    write: isWriteCommand(command),
  };
}

// The decision for a call whose directory and workspace are known.
/**
 * @param {string} command
 * @param {string} cwd
 * @param {string} workspaceRoot
 */
async function decideCall(command, cwd, workspaceRoot) {
  const scripts = defaultScripts(workspaceRoot);
  const api = await loadAccessApi(scripts.access);
  return decideShell(
    { command },
    {
      cwd,
      lookup: (dir) => fleetLookup(dir, workspaceRoot),
      resolve: (repo, text, remoteUrl) =>
        resolveAccess(api, scripts.access, repo, text, remoteUrl),
      remoteUrl: gitRemoteUrl,
    },
  );
}

// The PreToolUse output for one allowed gh call: a rewrite through the launcher, or a refusal
// when it runs under PowerShell or without Git Bash.
/**
 * @param {NonNullable<ReturnType<typeof parseCall>>} call
 * @param {{ repo: string | null, level: string }} decision
 * @param {string} workspaceRoot
 * @param {{ env?: Record<string, string | undefined> }} options
 */
function gitHubCallOutput(call, decision, workspaceRoot, options) {
  if (call.tool === "PowerShell") {
    return denyOutput(
      denyMessage(
        `${decision.repo} runs gh through the Bash tool; run this gh command with Bash, not PowerShell`,
      ),
    );
  }
  if (!gitBashPath(options.env ?? process.env)) {
    return denyOutput(
      denyMessage(
        "Git Bash was not found; set CLAUDE_CODE_GIT_BASH_PATH to its bash.exe",
      ),
    );
  }
  return rewriteOutput(
    call.toolInput,
    launcherCommand({
      workspace: workspaceRoot,
      repo: decision.repo ?? "",
      command: call.command,
    }),
    gitHubCallReason(decision, call.command),
    readOnlyGh(call.command) ? "allow" : "ask",
  );
}

// The PreToolUse decision for one Bash or PowerShell call.
//   - A call that runs the launcher as its program is denied.
//   - A call with no working directory is denied when it is a write, and passed when a read.
//     A gh call is a write for this purpose (gate.mjs isWriteCommand), so it is denied too.
//   - A call the plugin cannot find its workspace for is denied when it is a write.
//   - A call the gate denies is denied with the gate's reason.
//   - An allowed gh call is rewritten to run through the launcher: "allow" for a read, "ask"
//     otherwise. A PowerShell gh call is denied instead, because the launcher runs under Git Bash.
//   - Anything else passes untouched (null).
/**
 * @param {any} input
 * @param {{ workspaceRoot?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {Promise<object | null>}
 */
export async function handlePreToolUse(input, options = {}) {
  const call = parseCall(input);
  if (!call) return null;
  if (runsLauncher(call.command))
    return denyOutput(
      denyMessage("the GitHub token launcher is not for direct use"),
    );

  const workspaceRoot = trustedWorkspace(options);
  if (!call.cwd || !workspaceRoot) {
    if (!call.write) return null;
    const reason = call.cwd
      ? "the plugin is not installed in a trusted workspace layout, so the gate cannot find the resolver for this write"
      : "the gate could not determine the working directory for this write";
    return denyOutput(denyMessage(reason));
  }

  const decision = await decideCall(call.command, call.cwd, workspaceRoot);
  if (decision.action === "deny")
    return denyOutput(
      denyMessage(decision.reason ?? "the gate denied this command"),
    );
  if (decision.action !== "inject") return null;
  return gitHubCallOutput(call, decision, workspaceRoot, options);
}

// The agent-access line for a session that starts inside a fleet repository.
/**
 * @param {any} input
 * @param {{ workspaceRoot?: string }} [options]
 * @returns {Promise<object | null>}
 */
export async function handleSessionStart(input, options = {}) {
  const cwd =
    typeof input?.cwd === "string" && input.cwd.length > 0 ? input.cwd : null;
  const workspaceRoot = trustedWorkspace(options);
  if (!cwd || !workspaceRoot) return null;
  const repo = fleetLookup(cwd, workspaceRoot).repo;
  if (!repo) return null;
  const api = await loadAccessApi(defaultScripts(workspaceRoot).access);
  return sessionContextOutput(contextLine(repo, levelFor(api, repo)));
}

// The one rule for a hook run that ran out of budget (or was killed at its outer limit):
// a write is denied and a read passes. For a hook that cannot block (SessionStart) there is
// nothing to answer. An input that cannot be read at all is treated as a write.
/**
 * @param {any} input the parsed hook input, or undefined when it could not be parsed
 * @param {{ blockOnError?: boolean }} options
 * @returns {object | null}
 */
export function budgetAnswer(input, options) {
  if (!options.blockOnError) return null;
  if (!input || typeof input !== "object")
    return denyOutput(denyMessage(BUDGET_REASON));
  const gated = GATED_TOOLS.includes(input.tool_name);
  if (!gated) return null;
  const command = input.tool_input?.command;
  if (typeof command !== "string" || isWriteCommand(command))
    return denyOutput(denyMessage(BUDGET_REASON));
  return null;
}

const BUDGET_REASON =
  "the gate ran out of time before it could decide this write; run it again";

// Read the hook's JSON from stdin, run the handler under the time budget, and print its
// output on stdout. Stdout carries JSON only. An internal error goes to stderr. With
// blockOnError (PreToolUse) the process exits 2, the documented blocking exit, and the
// stderr line is shown to the model. A run that runs out of budget gets budgetAnswer.
/**
 * @param {(input: any) => Promise<object | null>} handler
 * @param {{ blockOnError?: boolean, budgetMs?: number, input?: string, write?: (text: string) => void }} [options] input and write are for tests
 */
export async function runHook(handler, options = {}) {
  const budgetMs = options.budgetMs ?? PRE_TOOL_USE_BUDGET.budgetMs;
  const write = options.write ?? ((text) => process.stdout.write(text));
  let input;
  try {
    startBudget(budgetMs);
    input = JSON.parse(options.input ?? (await readStdin()));
    const output = await withDeadline(handler(input), budgetMs, () =>
      budgetAnswer(input, options),
    );
    emit(output, write);
    process.exitCode = 0;
  } catch (error) {
    if (error instanceof BudgetExhausted) {
      emit(budgetAnswer(input, options), write);
      process.exitCode = 0;
    } else {
      reportFailure(error, options);
    }
  } finally {
    clearBudget();
  }
}

// One JSON answer on stdout, when there is one.
/**
 * @param {object | null} output
 * @param {(text: string) => void} write
 */
function emit(output, write) {
  if (output) write(`${JSON.stringify(output)}\n`);
}

// An internal failure: a block with its reason for PreToolUse, a quiet pass otherwise.
/**
 * @param {unknown} error
 * @param {{ blockOnError?: boolean }} options
 */
function reportFailure(error, options) {
  const message = error instanceof Error ? error.message : String(error);
  if (options.blockOnError) {
    process.stderr.write(
      `simpsonm09-org-ai-plugin hook: the gate could not evaluate this command (${message}), so the command is blocked.\n`,
    );
    process.exitCode = 2;
  } else {
    process.stderr.write(`simpsonm09-org-ai-plugin hook: ${message}\n`);
    process.exitCode = 0;
  }
}

// Race the handler against the budget. The budget timer does not stop a synchronous child
// process already running; the entry point's outer kill bounds that (hooks/lib/entry.mjs).
/**
 * @template T
 * @param {Promise<T>} work
 * @param {number} ms
 * @param {() => T} onTimeout
 * @returns {Promise<T>}
 */
function withDeadline(work, ms, onTimeout) {
  let timer;
  const deadline = new Promise((resolveDeadline) => {
    timer = setTimeout(() => resolveDeadline(onTimeout()), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * @returns {Promise<string>}
 */
export async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}
