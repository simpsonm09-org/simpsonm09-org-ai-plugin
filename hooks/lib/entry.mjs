// The guard around one hook run. Claude Code allows a hook that runs past its timeout, and
// the resolver's catalog read is synchronous with no timeout of its own, so an in-process
// timer cannot bound it. The hook process therefore runs the handler in a worker process
// (hooks/worker.mjs) and kills it at the outer limit. A killed worker gets the same budget
// rule the handler uses (budgetAnswer in claude.mjs): a write is denied and a read passes.
// A worker that fails for any other reason fails closed for PreToolUse (exit 2).

import { spawnSync as nodeSpawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRE_TOOL_USE_BUDGET,
  SESSION_START_BUDGET,
} from "../../lib/budget.mjs";
import { budgetAnswer } from "./claude.mjs";

export const WORKER = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "worker.mjs",
);

// The largest output a worker may write back to the hook process.
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * @param {"pre" | "session"} kind
 * @returns {{ budgetMs: number, killMs: number }}
 */
export function budgetFor(kind) {
  return kind === "pre" ? PRE_TOOL_USE_BUDGET : SESSION_START_BUDGET;
}

// The hook's own JSON answer for a worker that was killed: a deny for a write, nothing for a
// read. The input may not parse, which the budget rule treats as a write.
/**
 * @param {string} input
 * @param {boolean} blockOnError
 * @returns {string}
 */
function killedAnswer(input, blockOnError) {
  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    parsed = undefined;
  }
  const output = budgetAnswer(parsed, { blockOnError });
  return output ? `${JSON.stringify(output)}\n` : "";
}

// Whether a failed worker run was the outer limit (a kill at timeout) rather than a failure to
// start or a crash.
/**
 * @param {{ error?: any, signal?: string | null }} result
 * @returns {boolean}
 */
function wasKilled(result) {
  return result.error?.code === "ETIMEDOUT" || Boolean(result.signal);
}

/**
 * Run one hook through its worker and return the exit code for the hook process.
 * @param {{
 *   kind: "pre" | "session",
 *   input: string,
 *   stdout: (text: string) => void,
 *   stderr: (text: string) => void,
 *   spawn?: typeof nodeSpawnSync,
 *   worker?: string,
 * }} run
 * @returns {number}
 */
export function runGuardedHook({
  kind,
  input,
  stdout,
  stderr,
  spawn = nodeSpawnSync,
  worker = WORKER,
}) {
  const blockOnError = kind === "pre";
  const result = spawn(process.execPath, [worker, kind], {
    input,
    encoding: "utf8",
    timeout: budgetFor(kind).killMs,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
  });

  if (wasKilled(result)) {
    const answer = killedAnswer(input, blockOnError);
    if (answer) stdout(answer);
    return 0;
  }
  if (result.error || result.status === null) {
    stderr(
      `simpsonm09-org-ai-plugin hook could not run its worker (${result.error?.message ?? "no exit status"}).\n`,
    );
    return blockOnError ? 2 : 0;
  }
  if (result.status === 0) {
    if (result.stdout) stdout(result.stdout);
    return 0;
  }
  if (result.stderr) stderr(result.stderr);
  return blockOnError ? 2 : 0;
}

/**
 * The whole hook input from stdin, read before the worker starts.
 * @returns {Promise<string>}
 */
export async function readHookInput() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}
