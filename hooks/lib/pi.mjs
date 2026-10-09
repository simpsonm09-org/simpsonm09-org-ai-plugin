// The Pi coding agent side of the agent-access gate. Pi calls an extension's tool_call handler
// before each tool call. The decision is not made here: it is the Claude adapter's
// (hooks/lib/claude.mjs), which applies decideShell (gate.mjs) to the command. This module maps
// Pi's event onto that adapter and applies its answer to the call: a deny blocks the call, an
// allowed gh call has its command replaced by the launcher line, and an ask is put to the person
// when the session has a way to ask.
//
// Only the bash tool is gated, and it is read as a Bash call in the directory Pi reports
// (ctx.cwd). The workspace is the one this plugin is installed in (lib/location.mjs), never the
// working directory or the environment. An error in the gate blocks the call.

import { handlePreToolUse } from "./claude.mjs";

// The one Pi tool the gate covers.
const GATED_TOOL = "bash";

// The title of the approval prompt for an ask.
const APPROVAL_TITLE = "agent-access: approve this gh command?";

// The opt-in that lets an ask through when nobody is at the prompt: an rpc session (T3 drives Pi
// that way), or a session with no prompt. A session with a prompt that is not rpc still asks the
// person. The launcher wrapper sets it for the whole Pi process tree, and it is read from this
// process's own environment. It changes only an ask. A denial stays a denial.
export const PI_ASK_VARIABLE = "AGENT_ACCESS_PI_ASK";

/**
 * Whether the extension process was started with the ask switch set to exactly "allow".
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function askIsAllowed(env = process.env) {
  return env[PI_ASK_VARIABLE] === "allow";
}

/**
 * @param {string} reason
 * @returns {{ block: true, reason: string }}
 */
function block(reason) {
  return { block: true, reason };
}

// Replace the command of the call in place, so the tool runs the rewritten command.
/**
 * @param {{ input: Record<string, unknown> }} event
 * @param {string} command
 */
function rewrite(event, command) {
  event.input.command = command;
}

// Whether the session has a prompt at all: a UI with a confirm on it. An rpc session has one too.
/**
 * @param {{ hasUI?: boolean, ui?: { confirm?: unknown } } | undefined} ctx
 * @returns {boolean}
 */
function canPrompt(ctx) {
  return ctx?.hasUI === true && typeof ctx.ui?.confirm === "function";
}

// The answer to a call the gate asked about. A read-only gh call is already an allow, so this is
// only the other gh writes and any other ask. A session with a prompt asks the person, except that
// with the ask switch an rpc session is not asked: nobody answers its prompt, which resolves false
// after 3 seconds, so the ask is rewritten at once. A session with no prompt is rewritten under the
// switch and blocked without it. A session whose mode is missing or unknown is asked, so an
// unanswered prompt fails closed. A failing prompt throws, and the caller blocks the call.
/**
 * @param {{ input: Record<string, unknown> }} event
 * @param {{ hasUI?: boolean, mode?: unknown, ui?: { confirm?: (title: string, message: string) => Promise<boolean> } } | undefined} ctx
 * @param {{ permissionDecisionReason?: string, updatedInput: { command: string } }} hook
 * @returns {Promise<{ block: true, reason: string } | undefined>}
 */
async function answerAsk(event, ctx, hook) {
  const reason = hook.permissionDecisionReason ?? "";
  const switchOn = askIsAllowed();
  if (canPrompt(ctx) && !(switchOn && ctx.mode === "rpc")) {
    const approved = (await ctx.ui?.confirm?.(APPROVAL_TITLE, reason)) === true;
    if (approved) {
      rewrite(event, hook.updatedInput.command);
      return undefined;
    }
    return block(`${reason}; the person did not approve it`);
  }
  if (switchOn) {
    rewrite(event, hook.updatedInput.command);
    return undefined;
  }
  return block(
    `${reason}; this session cannot ask for approval, so the command is blocked`,
  );
}

// The Pi answer for the Claude answer to one call. No answer passes the call.
/**
 * @param {{ input: Record<string, unknown> }} event
 * @param {object} ctx
 * @param {{ permissionDecision?: string, permissionDecisionReason?: string, updatedInput?: { command: string } } | undefined} hook
 * @returns {Promise<{ block: true, reason: string } | undefined>}
 */
async function applyAnswer(event, ctx, hook) {
  if (!hook) return undefined;
  if (hook.permissionDecision === "deny")
    return block(
      hook.permissionDecisionReason ?? "the gate denied this command",
    );
  if (hook.permissionDecision === "allow") {
    rewrite(event, hook.updatedInput.command);
    return undefined;
  }
  return answerAsk(event, ctx, hook);
}

// The Pi tool_call decision for one call. It returns { block, reason } to stop the call, sets the
// command of an allowed gh call to its launcher line, and returns nothing otherwise. Any error
// blocks the call, so a call the gate cannot evaluate does not run.
/**
 * @param {{ toolName: string, input: Record<string, unknown> }} event
 * @param {{ cwd?: string, hasUI?: boolean, ui?: { confirm?: (title: string, message: string) => Promise<boolean> } }} ctx
 * @param {{ workspaceRoot?: string }} [options] workspaceRoot is for tests; nothing else chooses it
 * @returns {Promise<{ block: true, reason: string } | undefined>}
 */
export async function gateToolCall(event, ctx, options = {}) {
  if (String(event?.toolName).toLowerCase() !== GATED_TOOL) return undefined;
  try {
    const output = await handlePreToolUse(
      { tool_name: "Bash", tool_input: event.input, cwd: ctx?.cwd },
      { workspaceRoot: options.workspaceRoot },
    );
    return await applyAnswer(event, ctx, output?.hookSpecificOutput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return block(
      `the gate could not evaluate this command (${message}), so the command is blocked`,
    );
  }
}
