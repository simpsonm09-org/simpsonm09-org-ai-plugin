// The guard that runs each hook in a worker process (hooks/lib/entry.mjs). A worker killed at
// its outer limit gets the budget rule; a worker that fails any other way fails closed for
// PreToolUse. The spawn is injected so each case is exact, and one case runs the real worker.

import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetFor, runGuardedHook } from "../hooks/lib/entry.mjs";
import { PRE_TOOL_USE_BUDGET, SESSION_START_BUDGET } from "../lib/budget.mjs";

const WRITE =
  '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}';
const READ = '{"tool_name":"Bash","tool_input":{"command":"ls"}}';

type Fake = {
  status?: number | null;
  signal?: string | null;
  error?: { code?: string; message?: string };
  stdout?: string;
  stderr?: string;
};

// A spawn that returns the given result and records its arguments.
function fakeSpawn(result: Fake) {
  const calls: Array<{ args: string[]; options: Record<string, unknown> }> = [];
  const spawn = ((
    _command: string,
    args: string[],
    options: Record<string, unknown>,
  ) => {
    calls.push({ args, options });
    return { status: 0, signal: null, stdout: "", stderr: "", ...result };
  }) as never;
  return { spawn, calls };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
  };
}

const timedOut = {
  error: { code: "ETIMEDOUT", message: "spawnSync ETIMEDOUT" },
  signal: "SIGTERM",
  status: null,
};

test("the worker is started with the kind and the input, and killed at the outer limit", () => {
  const { spawn, calls } = fakeSpawn({ status: 0, stdout: "" });
  const io = capture();
  assert.equal(runGuardedHook({ kind: "pre", input: READ, spawn, ...io }), 0);
  assert.deepEqual(calls[0].args.slice(1), ["pre"]);
  assert.equal(calls[0].options.input, READ);
  assert.equal(calls[0].options.timeout, PRE_TOOL_USE_BUDGET.killMs);
});

test("a PreToolUse worker killed at its limit denies a write", () => {
  const { spawn } = fakeSpawn(timedOut);
  const io = capture();
  assert.equal(runGuardedHook({ kind: "pre", input: WRITE, spawn, ...io }), 0);
  assert.equal(
    JSON.parse(io.out[0]).hookSpecificOutput.permissionDecision,
    "deny",
  );
});

test("a PreToolUse worker killed at its limit passes a read", () => {
  const { spawn } = fakeSpawn(timedOut);
  const io = capture();
  assert.equal(runGuardedHook({ kind: "pre", input: READ, spawn, ...io }), 0);
  assert.deepEqual(io.out, []);
});

test("a killed worker with unreadable input is a deny: an unknown call is not a read", () => {
  const { spawn } = fakeSpawn(timedOut);
  const io = capture();
  assert.equal(
    runGuardedHook({ kind: "pre", input: "not json", spawn, ...io }),
    0,
  );
  assert.equal(
    JSON.parse(io.out[0]).hookSpecificOutput.permissionDecision,
    "deny",
  );
});

test("a SessionStart worker killed at its limit answers nothing and does not block", () => {
  const { spawn } = fakeSpawn(timedOut);
  const io = capture();
  assert.equal(
    runGuardedHook({ kind: "session", input: "{}", spawn, ...io }),
    0,
  );
  assert.deepEqual(io.out, []);
});

test("a worker that finishes passes its output through", () => {
  const { spawn } = fakeSpawn({ status: 0, stdout: '{"ok":true}\n' });
  const io = capture();
  assert.equal(runGuardedHook({ kind: "pre", input: READ, spawn, ...io }), 0);
  assert.deepEqual(io.out, ['{"ok":true}\n']);
});

test("a PreToolUse worker that exits 2 blocks, and its reason is shown", () => {
  const { spawn } = fakeSpawn({ status: 2, stderr: "why\n" });
  const io = capture();
  assert.equal(runGuardedHook({ kind: "pre", input: READ, spawn, ...io }), 2);
  assert.deepEqual(io.err, ["why\n"]);
});

test("a worker that cannot start fails closed for PreToolUse and is quiet for SessionStart", () => {
  const failed = {
    error: { code: "ENOENT", message: "spawn node ENOENT" },
    status: null,
  };
  const pre = capture();
  assert.equal(
    runGuardedHook({
      kind: "pre",
      input: READ,
      spawn: fakeSpawn(failed).spawn,
      ...pre,
    }),
    2,
  );
  const session = capture();
  assert.equal(
    runGuardedHook({
      kind: "session",
      input: "{}",
      spawn: fakeSpawn(failed).spawn,
      ...session,
    }),
    0,
  );
});

test("a crashed PreToolUse worker (exit 1) fails closed, and a crashed SessionStart worker does not block", () => {
  const io = capture();
  assert.equal(
    runGuardedHook({
      kind: "pre",
      input: READ,
      spawn: fakeSpawn({ status: 1, stderr: "boom" }).spawn,
      ...io,
    }),
    2,
  );
  assert.equal(
    runGuardedHook({
      kind: "session",
      input: "{}",
      spawn: fakeSpawn({ status: 1, stderr: "boom" }).spawn,
      ...io,
    }),
    0,
  );
});

test("each kind's outer kill is below its hooks.json timeout", () => {
  assert.ok(budgetFor("pre").killMs < 60_000);
  assert.ok(budgetFor("session").killMs < 30_000);
  assert.equal(budgetFor("session"), SESSION_START_BUDGET);
});

test("the real worker answers a SessionStart call outside the fleet with nothing", () => {
  const io = capture();
  assert.equal(
    runGuardedHook({ kind: "session", input: '{"cwd":"/nowhere"}', ...io }),
    0,
  );
  assert.deepEqual(io.out, []);
});

test("the real worker denies a write with no working directory, through the real process", () => {
  const io = capture();
  assert.equal(runGuardedHook({ kind: "pre", input: WRITE, ...io }), 0);
  assert.equal(
    JSON.parse(io.out[0]).hookSpecificOutput.permissionDecision,
    "deny",
  );
});
