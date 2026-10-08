// The GitHub Copilot CLI side of the agent-access gate. The decision is the Claude adapter's
// (hooks/lib/claude.mjs), which is the shared one (gate.mjs). This module maps the wire format
// in both directions: it reads the native Copilot payload into the call the Claude adapter reads,
// and it maps the Claude answer onto Copilot's output, where a rewrite is `modifiedArgs` and a
// decision is `permissionDecision` at the top level.
//
// The hooks file uses the camelCase event keys (preToolUse, sessionStart), so Copilot sends its
// native payload, measured on Copilot CLI 1.0.93:
//   {"sessionId":"…","timestamp":…,"cwd":"…","toolName":"powershell","toolArgs":{"command":"…","description":"…"}}
// The shell's dialect is the tool name: `powershell` is PowerShell, `bash` is Bash. With the
// PascalCase keys Copilot instead sends Claude's payload, where a PowerShell call is reported as
// `"tool_name":"Bash"`. That shape cannot say which dialect runs the command, so this adapter
// refuses it rather than guessing.
//
// Two kinds of answer are not an error. A refusal (PascalCase payload, or a tool other than the
// two shell tools) is a deny with a reason. A payload that is not an object, or names no tool,
// throws, and the entry point exits 2, which Copilot also denies.

import { denyMessage } from "../../gate.mjs";
import {
  budgetAnswer as claudeBudgetAnswer,
  handlePreToolUse as claudePreToolUse,
  handleSessionStart as claudeSessionStart,
} from "./claude.mjs";

// The Copilot-only sentence added to the session context of a fleet repository. The model has been
// composing launcher lines by hand, so it is told to type the plain command and nothing else.
export const SESSION_NOTE =
  "Gh commands may appear in your history rewritten to run through a GitHub token launcher. Keep typing plain gh and git commands, and never write the launcher line yourself: the gate adds the token.";

// Copilot's shell tools, by the tool name the native payload carries, and the dialect each one
// reads its command in, as the Claude adapter names them.
const SHELL_TOOLS = new Map([
  ["bash", "Bash"],
  ["powershell", "PowerShell"],
]);

const PASCAL_CASE_REASON =
  "this Copilot hook received Claude's PascalCase payload (tool_name), which does not say whether the command is PowerShell or Bash, so the gate cannot read it; the plugin's Copilot hooks file must use the camelCase event keys";

// The deny for a call the adapter does not decide, or null when the call is one it can read.
/**
 * @param {any} input the parsed hook input
 * @returns {{ permissionDecision: "deny", permissionDecisionReason: string } | null}
 */
function refusal(input) {
  if (!input || typeof input !== "object") return null;
  if (typeof input.toolName !== "string") {
    return typeof input.tool_name === "string"
      ? denyAnswer(PASCAL_CASE_REASON)
      : null;
  }
  if (!SHELL_TOOLS.has(input.toolName))
    return denyAnswer(
      `this hook gates only the bash and powershell tools, and the call names "${input.toolName}"`,
    );
  return null;
}

/**
 * @param {string} reason
 */
function denyAnswer(reason) {
  return {
    permissionDecision: "deny",
    permissionDecisionReason: denyMessage(reason),
  };
}

/**
 * The call in the shape the Claude adapter reads: tool_name, tool_input, and cwd. The dialect is
 * carried in tool_name: the native `powershell` becomes `PowerShell`, and `bash` becomes `Bash`.
 * @param {any} input the parsed hook input
 * @returns {{ tool_name: string, tool_input: unknown, cwd: unknown }}
 */
export function normalizeCall(input) {
  if (!input || typeof input !== "object")
    throw new Error("the hook input is not an object");
  if (typeof input.toolName !== "string")
    throw new Error("the Copilot hook input names no tool");
  return {
    tool_name: SHELL_TOOLS.get(input.toolName) ?? input.toolName,
    tool_input: input.toolArgs,
    cwd: input.cwd,
  };
}

// The Copilot output for one Claude PreToolUse answer, or null for no answer. A rewrite is
// `modifiedArgs`, the replacement tool arguments, and it keeps every field the call had.
/**
 * @param {object | null} claude
 * @returns {object | null}
 */
export function preToolUseOutput(claude) {
  const hook = claude?.hookSpecificOutput;
  if (!hook) return null;
  const output = { permissionDecision: hook.permissionDecision };
  if (hook.permissionDecisionReason !== undefined)
    output.permissionDecisionReason = hook.permissionDecisionReason;
  if (hook.updatedInput !== undefined) output.modifiedArgs = hook.updatedInput;
  return output;
}

/**
 * @param {any} input
 * @param {{ workspaceRoot?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {Promise<object | null>}
 */
export async function handlePreToolUse(input, options = {}) {
  const denied = refusal(input);
  if (denied) return denied;
  const claude = await claudePreToolUse(normalizeCall(input), {
    ...options,
    toolShells: true,
  });
  return preToolUseOutput(claude);
}

/**
 * Copilot reads only additionalContext from a SessionStart answer.
 * @param {any} input
 * @param {{ workspaceRoot?: string }} [options]
 * @returns {Promise<object | null>}
 */
export async function handleSessionStart(input, options = {}) {
  const claude = await claudeSessionStart(input, options);
  const text = claude?.hookSpecificOutput?.additionalContext;
  return typeof text === "string"
    ? { additionalContext: `${text} ${SESSION_NOTE}` }
    : null;
}

// The call the budget rule reads, or undefined when the input cannot be read as a call. The
// Claude rule treats an undefined call as a write, so an unreadable call is denied.
/**
 * @param {any} input
 * @returns {object | undefined}
 */
function readableCall(input) {
  try {
    return normalizeCall(input);
  } catch {
    return undefined;
  }
}

/**
 * The answer when a run ran out of budget or was killed: the same refusals as a normal run, and
 * otherwise the Claude rule, in Copilot's output.
 * @param {any} input the parsed hook input, or undefined when it could not be parsed
 * @param {{ blockOnError?: boolean }} options
 * @returns {object | null}
 */
export function budgetAnswer(input, options) {
  if (!options.blockOnError) return null;
  return (
    refusal(input) ??
    preToolUseOutput(claudeBudgetAnswer(readableCall(input), options))
  );
}
