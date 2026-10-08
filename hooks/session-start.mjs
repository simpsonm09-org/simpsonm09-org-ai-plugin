#!/usr/bin/env node
// Claude Code SessionStart hook. When the session starts inside a fleet repository, it adds
// the same agent-access line the OpenCode plugin adds to the system prompt. Outside a fleet
// repository it prints nothing. It never blocks a session: an internal error is reported on
// stderr only, and the worker is killed at its outer limit (hooks/lib/entry.mjs).

try {
  const { readHookInput, runGuardedHook } = await import("./lib/entry.mjs");
  const input = await readHookInput();
  process.exitCode = runGuardedHook({
    kind: "session",
    input,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `simpsonm09-org-ai-plugin hook could not start: ${message}\n`,
  );
  process.exitCode = 0;
}
