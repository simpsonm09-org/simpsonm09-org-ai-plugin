#!/usr/bin/env node
// PreToolUse hook for the Bash and PowerShell tools, for Claude Code and the GitHub Copilot CLI.
// The first argument names the runtime (claude when there is none, copilot for the Copilot
// hooks file). The decision is made by a worker process (hooks/worker.mjs) that this entry
// starts and kills at the outer limit; see hooks/lib/entry.mjs. Any failure blocks the call: the
// guard is imported inside the try, so a crash at import time is caught here, and the process
// exits 2, the documented blocking exit. Claude Code treats any other non-zero exit as
// non-blocking, so a crash that exited 1 would let the command run unchecked. Copilot denies
// the call on exit 2 and on any other non-zero exit.

try {
  const { readHookInput, runGuardedHook } = await import("./lib/entry.mjs");
  const input = await readHookInput();
  process.exitCode = runGuardedHook({
    kind: "pre",
    runtime: process.argv[2],
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
