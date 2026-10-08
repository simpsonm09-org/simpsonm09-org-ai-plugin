#!/usr/bin/env node
// Claude Code PreToolUse hook for the Bash and PowerShell tools. The decision is made by a
// worker process (hooks/worker.mjs) that this entry starts and kills at the outer limit; see
// hooks/lib/entry.mjs. Any failure blocks the call: the guard is imported inside the try, so
// a crash at import time is caught here, and the process exits 2, the documented blocking
// exit. Claude Code treats any other non-zero exit as non-blocking, so a crash that exited 1
// would let the command run unchecked.

try {
  const { readHookInput, runGuardedHook } = await import("./lib/entry.mjs");
  const input = await readHookInput();
  process.exitCode = runGuardedHook({
    kind: "pre",
    input,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `simpsonm09-org-ai-plugin hook could not start (${message}), so the command is blocked.\n`,
  );
  process.exitCode = 2;
}
