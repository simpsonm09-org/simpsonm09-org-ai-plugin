// The hook runtimes the plugin serves. A hooks file names its runtime as the first argument of
// its hook command: Claude Code's hooks pass none, so they are the default (claude), and the
// Copilot CLI hooks pass copilot. Each runtime exports the same three functions: the PreToolUse
// handler, the SessionStart handler, and the budget rule (hooks/lib/entry.mjs, hooks/worker.mjs).
// An unknown name throws, so a hook started with it fails closed.

import * as claude from "./claude.mjs";
import * as copilot from "./copilot.mjs";

const RUNTIMES = new Map([
  ["claude", claude],
  ["copilot", copilot],
]);

/**
 * @param {string} [name]
 * @returns {typeof claude}
 */
export function runtimeNamed(name = "claude") {
  const runtime = RUNTIMES.get(name);
  if (!runtime) throw new Error(`unknown hook runtime "${name}"`);
  return runtime;
}
