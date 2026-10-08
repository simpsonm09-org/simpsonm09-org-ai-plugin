// A time budget for one hook run. Claude Code treats a hook that runs past its timeout as
// allowed, so each hook spends its own budget and answers inside it. Two limits apply:
//
//   - budgetMs: the internal budget. Every child process and broker call asks timeoutFor()
//     for its limit; it returns the smaller of its own limit and what is left, and throws a
//     BudgetExhausted when nothing is left.
//   - killMs: the outer limit the entry point enforces on the whole worker process. The
//     resolver's catalog read is synchronous and has no timeout of its own, so only a
//     process kill can bound it. killMs is above budgetMs and below the hook's timeout in
//     hooks/hooks.json.
//
// Both limits follow one rule, applied where the budget runs out (hooks/lib/claude.mjs):
// a write is denied and a read passes.

// The PreToolUse hook has a 60 second timeout in hooks/hooks.json.
export const PRE_TOOL_USE_BUDGET = Object.freeze({
  budgetMs: 40_000,
  killMs: 45_000,
});

// The SessionStart hook has a 30 second timeout in hooks/hooks.json.
export const SESSION_START_BUDGET = Object.freeze({
  budgetMs: 15_000,
  killMs: 20_000,
});

// The answer for a hook run with no budget left. It is not an internal failure: the
// caller decides, by the one rule above.
export class BudgetExhausted extends Error {
  constructor() {
    super("the gate ran out of time");
    this.name = "BudgetExhausted";
  }
}

let deadline = Number.POSITIVE_INFINITY;

/**
 * @param {number} ms
 */
export function startBudget(ms = PRE_TOOL_USE_BUDGET.budgetMs) {
  deadline = Date.now() + ms;
}

export function clearBudget() {
  deadline = Number.POSITIVE_INFINITY;
}

/**
 * The timeout for one call, bounded by the budget that is left.
 * @param {number} maxMs
 * @returns {number}
 */
export function timeoutFor(maxMs) {
  const left = deadline - Date.now();
  if (left <= 0) throw new BudgetExhausted();
  return Math.max(1, Math.min(maxMs, left));
}
