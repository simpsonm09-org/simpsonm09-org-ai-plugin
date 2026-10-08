// The GitHub Copilot CLI side of the agent-access gate. The decision is the Claude adapter's
// (hooks/lib/claude.mjs), which is the shared one (gate.mjs). This module only maps the wire
// format: it reads the Copilot payload into the call the Claude adapter reads, and it maps the
// Claude answer onto Copilot's output, where a rewrite is `modifiedArgs` and a decision is
// `permissionDecision` at the top level.
//
// A Copilot hook receives one of two payloads, depending on its event key. The camelCase key
// (preToolUse) gives `toolName` and `toolArgs`. The PascalCase key (PreToolUse) gives Claude's
// `tool_name` and `tool_input`. This adapter reads both. A payload with neither is malformed,
// and a malformed PreToolUse payload is an error, which the entry point turns into exit 2 (a deny).

import {
  budgetAnswer as claudeBudgetAnswer,
  handlePreToolUse as claudePreToolUse,
  handleSessionStart as claudeSessionStart,
} from "./claude.mjs";

// Copilot's tool names for the two shell tools, as the Claude adapter names them. Any other
// tool passes through under its own name, and the Claude adapter ignores it.
const CLAUDE_TOOL_NAMES = new Map([
  ["bash", "Bash"],
  ["powershell", "PowerShell"],
]);

/**
 * The call in the shape the Claude adapter reads: tool_name, tool_input, and cwd.
 * @param {any} input the parsed hook input
 * @returns {{ tool_name: string, tool_input: unknown, cwd: unknown }}
 */
export function normalizeCall(input) {
  if (!input || typeof input !== "object")
    throw new Error("the hook input is not an object");
  if (typeof input.toolName === "string") {
    return {
      tool_name: CLAUDE_TOOL_NAMES.get(input.toolName) ?? input.toolName,
      tool_input: input.toolArgs,
      cwd: input.cwd,
    };
  }
  if (typeof input.tool_name === "string") {
    return {
      tool_name: CLAUDE_TOOL_NAMES.get(input.tool_name) ?? input.tool_name,
      tool_input: input.tool_input,
      cwd: input.cwd,
    };
  }
  throw new Error("the Copilot hook input names no tool");
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
  return typeof text === "string" ? { additionalContext: text } : null;
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
 * The answer when a run ran out of budget or was killed: the Claude rule, in Copilot's output.
 * @param {any} input the parsed hook input, or undefined when it could not be parsed
 * @param {{ blockOnError?: boolean }} options
 * @returns {object | null}
 */
export function budgetAnswer(input, options) {
  if (!options.blockOnError) return null;
  return preToolUseOutput(claudeBudgetAnswer(readableCall(input), options));
}
