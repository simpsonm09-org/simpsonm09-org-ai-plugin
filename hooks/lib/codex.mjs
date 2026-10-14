// Codex's PreToolUse adapter for the shared shell gate. Codex reports its shell tool as Bash,
// with a command string and no dialect field. The measured Windows runtime executes that string
// as PowerShell; other platforms use Bash. Codex only blocks on a successful JSON deny, so every
// internal failure and every gate ask must become that same kind of deny.

import { writeSync } from "node:fs";
import { posix, win32 } from "node:path";
import { handlePreToolUse as claudePreToolUse } from "./claude.mjs";

const ASK_REASON =
  "this action needs human approval, which Codex PreToolUse cannot request; ask a human to approve it outside Codex before running it";

/**
 * @param {any} input
 * @param {string} [platform]
 * @returns {{ tool_name: string, tool_input: Record<string, unknown>, cwd: unknown } | null}
 */
export function normalizeCall(input, platform = process.platform) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("the hook input is not an object");
  if (input.hook_event_name !== "PreToolUse")
    throw new Error("the hook input is not a PreToolUse event");
  if (typeof input.tool_name !== "string")
    throw new Error("the Codex PreToolUse event has no string tool_name");
  if (input.tool_name !== "Bash") return null;
  if (
    !input.tool_input ||
    typeof input.tool_input !== "object" ||
    Array.isArray(input.tool_input) ||
    typeof input.tool_input.command !== "string"
  )
    throw new Error("the Bash call has no command string");

  if (typeof input.cwd !== "string" || input.cwd.length === 0)
    throw new Error("the Codex Bash payload has a missing or empty cwd");
  // The same platform picks the dialect and the absolute-path rule, so a test running on
  // Linux can exercise the Windows dialect with a real posix temp directory: win32.isAbsolute
  // reads a rooted path as absolute, and the gate below still resolves it with this host's
  // path rules.
  const absolute = platform === "win32"
    ? win32.isAbsolute(input.cwd)
    : posix.isAbsolute(input.cwd);
  if (!absolute)
    throw new Error("the Codex Bash payload has a relative cwd");

  return {
    tool_name: platform === "win32" ? "PowerShell" : "Bash",
    tool_input: input.tool_input,
    cwd: input.cwd,
  };
}

/**
 * @param {any} input
 * @param {{ workspaceRoot?: string, env?: Record<string, string | undefined>, platform?: string }} [options]
 */
export async function handlePreToolUse(input, options = {}) {
  const call = normalizeCall(input, options.platform);
  // The existing shell gate does not evaluate apply_patch, MCP, or other tool arguments.
  if (!call) return null;

  const answer = await claudePreToolUse(call, {
    workspaceRoot: options.workspaceRoot,
    env: options.env,
    toolShells: true,
    runtime: "codex",
  });
  const hook = answer?.hookSpecificOutput;
  if (hook?.permissionDecision === "ask") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: ASK_REASON,
      },
    };
  }
  // Codex allow is exit 0 with no output. It cannot consume Claude's input rewrite.
  if (hook?.permissionDecision === "allow") return null;
  return answer;
}

/**
 * Codex does not support the shared gate's prompt operation. Keep the Copilot convention for
 * promptless runtimes: ask becomes a deny unless a runtime explicitly defines an allow switch.
 * Codex has no such switch, so it always refuses the ask.
 * @param {any} input
 * @param {{ blockOnError?: boolean }} options
 */
export function budgetAnswer(input, options = {}) {
  if (!options.blockOnError) return null;
  return failureAnswer(JSON.stringify(input), "time budget exceeded");
}

/**
 * The failure response used by both the worker guard and the outer hook entry point. Only fixed
 * class names appear in the reason; exception text, paths, and resolver output are not included.
 * @param {string} input
 * @param {string} failureClass
 */
export function failureAnswer(input, failureClass) {
  const kind = failureClassFor(input, failureClass);
  const messages = {
    "invalid JSON input": "the Codex gate received invalid JSON input",
    "missing command": "the Codex gate received a Bash payload without a string tool_input.command",
    "invalid tool name": "the Codex gate received a PreToolUse payload without a string tool_name",
    "invalid cwd": "the Codex gate received a Bash payload with a missing, empty, non-string, or relative cwd",
    "wrong event": "the Codex gate received an event other than PreToolUse",
    "time budget exceeded": "the Codex gate exceeded its time budget",
    "worker could not start": "the Codex gate worker could not start",
    "hook could not start": "the Codex hook could not start",
    "gate or worker failure": "the Codex gate failed internally while evaluating this command",
    "uncaught exception": "the Codex hook encountered an uncaught internal failure",
    "unhandled rejection": "the Codex hook encountered an unhandled internal failure",
  };
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `${messages[kind] ?? messages["gate or worker failure"]}; the command is blocked`,
    },
  };
}

/**
 * Prefer a specific input failure over a generic worker failure classification.
 * @param {string} input
 * @param {string} fallback
 */
function failureClassFor(input, fallback) {
  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    return "invalid JSON input";
  }
  if (parsed?.hook_event_name !== "PreToolUse") return "wrong event";
  if (typeof parsed?.tool_name !== "string") return "invalid tool name";
  if (
    parsed?.tool_name === "Bash" &&
    typeof parsed?.tool_input?.command !== "string"
  )
    return "missing command";
  if (parsed?.tool_name === "Bash" && (
    typeof parsed?.cwd !== "string" || parsed.cwd.length === 0 ||
    (process.platform === "win32"
      ? !/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(parsed.cwd)
      : !parsed.cwd.startsWith("/"))
  )) return "invalid cwd";
  return fallback;
}

/**
 * Last-resort process handlers for failures that escape the entry point's normal catch path.
 * @param {(text: string) => void} write
 */
export function installLastResortHandlers(write) {
  const finish = (failureClass) => {
    const text = `${JSON.stringify(failureAnswer('{"hook_event_name":"PreToolUse"}', failureClass))}\n`;
    write(text);
    process.exit(0);
  };
  process.once("uncaughtException", () => finish("uncaught exception"));
  process.once("unhandledRejection", () => finish("unhandled rejection"));
}

/** Write Codex protocol output before the hook process exits. */
export function writeStdout(text) {
  const buffer = Buffer.from(text, "utf8");
  try {
    let offset = 0;
    // A large payload does not fit one pipe buffer. writeSync on a pipe is a single write, so
    // it returns a short count and reports no error; looping is what surfaces the closed pipe
    // as the EPIPE throw. On Windows the first write throws instead, so both platforms fail
    // into the same catch.
    while (offset < buffer.length) {
      const written = writeSync(1, buffer, offset, buffer.length - offset);
      if (written <= 0) throw new Error("the stdout write made no progress");
      offset += written;
    }
  } catch {
    try {
      process.stderr.write("simpsonm09-org-ai-plugin: Codex denial could not be delivered because stdout is closed.\n");
    } catch {
      // There is no protocol channel left to report through.
    }
    process.exitCode = 0;
  }
}
