#!/usr/bin/env node
// Runs one hook handler in its own process, under the hook's internal budget. The entry point
// (hooks/lib/entry.mjs) starts this process with the hook's JSON on stdin and kills it at the
// outer limit, which bounds a synchronous resolver call. Usage: node worker.mjs pre|session
// [claude|copilot]. The runtime defaults to claude.

import { PRE_TOOL_USE_BUDGET, SESSION_START_BUDGET } from "../lib/budget.mjs";

const kind = process.argv[2];
const blockOnError = kind === "pre";

try {
  const { runHook } = await import("./lib/claude.mjs");
  const { runtimeNamed } = await import("./lib/runtime.mjs");
  const runtime = runtimeNamed(process.argv[3]);
  if (blockOnError) {
    await runHook(runtime.handlePreToolUse, {
      blockOnError: true,
      budgetMs: PRE_TOOL_USE_BUDGET.budgetMs,
      answer: runtime.budgetAnswer,
    });
  } else {
    await runHook(runtime.handleSessionStart, {
      budgetMs: SESSION_START_BUDGET.budgetMs,
      answer: runtime.budgetAnswer,
    });
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`simpsonm09-org-ai-plugin hook: ${message}\n`);
  process.exitCode = blockOnError ? 2 : 0;
}
