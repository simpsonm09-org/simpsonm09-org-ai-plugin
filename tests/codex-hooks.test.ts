// Codex PreToolUse uses the same shell decision as Claude, but its hook protocol only blocks on
// a successful JSON deny. These tests cover the measured payload, platform dialect, the adapter's
// conservative ask rule, worker failures, and the real entry point.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { tokenize } from "../gate.mjs";
import { handlePreToolUse as handleClaudePreToolUse } from "../hooks/lib/claude.mjs";
import { handlePreToolUse, normalizeCall } from "../hooks/lib/codex.mjs";
import { runGuardedHook } from "../hooks/lib/entry.mjs";
import { runtimeNamed } from "../hooks/lib/runtime.mjs";
import {
  buildWorkspace,
  removeDir,
  tempDir,
  writeCatalog,
} from "./support/fixture-workspace.mjs";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRE_ENTRY = join(repoDir, "hooks", "pre-tool-use.mjs");
const TOKEN_ENV = { CLAUDE_CODE_GIT_BASH_PATH: process.execPath };
const SESSION_ID = "redacted-session";
const TOOL_ID = "redacted-tool-use";

// Redacted Codex 0.162.1 PreToolUse shape from the measured findings.
const measured = (cwd: string, command: string, toolName = "Bash") => ({
  session_id: SESSION_ID,
  turn_id: "redacted-turn",
  transcript_path: "<path>",
  cwd,
  hook_event_name: "PreToolUse",
  model: "gpt-6-luna",
  permission_mode: "bypassPermissions",
  tool_name: toolName,
  tool_input: { command },
  tool_use_id: TOOL_ID,
});

let ws = "";
const cwdOf = (rel: string) => join(ws, ...rel.split("/"));

before(() => {
  ws = tempDir("codex-hooks-");
  buildWorkspace(ws, { level: "read" });
});

after(() => {
  if (ws) removeDir(ws);
});

function decide(input: unknown, level = "read", platform = process.platform) {
  writeCatalog(ws, level);
  return handlePreToolUse(input, {
    workspaceRoot: ws,
    env: TOKEN_ENV,
    platform,
  });
}

function jsonDeny(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function assertCodexJson(result: { status: number | null; stdout: string }) {
  assert.equal(result.status, 0);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(value), ["hookSpecificOutput"]);
  assert.equal(value.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(value.hookSpecificOutput.permissionDecision, "deny");
  return value;
}

test("runtime selection registers codex and leaves unknown runtime errors intact", () => {
  assert.equal(runtimeNamed("codex").handlePreToolUse, handlePreToolUse);
  assert.throws(
    () => runtimeNamed("nonsense"),
    /unknown hook runtime "nonsense"/,
  );
});

test("the measured Codex payload allows an ordinary command and denies a blocked write", async () => {
  assert.equal(
    await decide(measured(cwdOf("projects/repos/demo-repo"), "npm test")),
    null,
  );
  const answer = await decide(
    measured(cwdOf("projects/repos/demo-repo"), "gh pr merge 1"),
  );
  assert.deepEqual(
    answer,
    jsonDeny(
      "agent-access: denied: Codex does not report which folder a command runs in, so GitHub writes from Codex are blocked in every repository. Push or open the pull request from Claude, OpenCode or Copilot.",
    ),
  );
});

test("Codex blocks classified GitHub writes regardless of cwd and access level", async () => {
  writeCatalog(ws, "full");
  const reason =
    "agent-access: denied: Codex does not report which folder a command runs in, so GitHub writes from Codex are blocked in every repository. Push or open the pull request from Claude, OpenCode or Copilot.";
  const fullRepo = cwdOf("projects/repos/demo-repo");
  const outsideRepo = cwdOf("projects/other/x");

  assert.deepEqual(
    await handlePreToolUse(measured(fullRepo, "git push origin main"), {
      workspaceRoot: ws,
      env: TOKEN_ENV,
    }),
    jsonDeny(reason),
  );
  for (const command of [
    "git push origin main",
    `git -C "${fullRepo}" push origin main`,
    "gh pr create --title test",
  ]) {
    assert.deepEqual(
      await handlePreToolUse(measured(outsideRepo, command), {
        workspaceRoot: ws,
        env: TOKEN_ENV,
      }),
      jsonDeny(reason),
    );
  }
});

test("Codex still allows reads and Claude still allows full-access GitHub writes", async () => {
  writeCatalog(ws, "full");
  const repo = cwdOf("projects/repos/demo-repo");
  for (const command of ["git status --short", "git log"]) {
    assert.equal(
      await handlePreToolUse(measured(repo, command), {
        workspaceRoot: ws,
        env: TOKEN_ENV,
      }),
      null,
    );
  }

  assert.equal(
    await handleClaudePreToolUse(
      {
        tool_name: "Bash",
        tool_input: { command: "git push origin main" },
        cwd: repo,
      },
      { workspaceRoot: ws, env: TOKEN_ENV },
    ),
    null,
  );
});

test("Bash maps to PowerShell on win32 and Bash elsewhere", () => {
  assert.deepEqual(normalizeCall(measured("C:/w", "npm test"), "win32"), {
    tool_name: "PowerShell",
    tool_input: { command: "npm test" },
    cwd: "C:/w",
  });
  assert.deepEqual(
    normalizeCall(measured(String.raw`\\server\share`, "npm test"), "win32"),
    {
      tool_name: "PowerShell",
      tool_input: { command: "npm test" },
      cwd: String.raw`\\server\share`,
    },
  );
  assert.deepEqual(normalizeCall(measured("/w", "npm test"), "linux"), {
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    cwd: "/w",
  });
});

test("Codex denies GitHub writes before they can become gate asks", async () => {
  const answer = await decide(
    measured(cwdOf("projects/repos/demo-repo"), "gh pr create --title test"),
    "full",
  );
  assert.equal(answer?.hookSpecificOutput.permissionDecision, "deny");
  assert.match(
    answer?.hookSpecificOutput.permissionDecisionReason,
    /Codex does not report which folder.*blocked in every repository/i,
  );
});

test("non-Bash tools are allowed without evaluation", async () => {
  assert.equal(
    await decide(
      measured(cwdOf("projects/repos/demo-repo"), "", "apply_patch"),
    ),
    null,
  );
  assert.equal(
    await decide(measured(cwdOf("projects/repos/demo-repo"), "", "mcp__x__y")),
    null,
  );
});

test("Codex normalizes malformed input, wrong events, and missing commands as internal failures", async () => {
  await assert.rejects(handlePreToolUse(null), /not an object/);
  await assert.rejects(
    handlePreToolUse({
      ...measured("C:/w", "npm test"),
      hook_event_name: "SessionStart",
    }),
    /not a PreToolUse event/,
  );
  await assert.rejects(
    handlePreToolUse({ ...measured("C:/w", "npm test"), tool_input: {} }),
    /no command string/,
  );
});

test("Codex converts malformed input, gate errors, worker crashes, and timeouts into JSON denies", () => {
  // An absolute cwd for the running platform, so the failure classifier reaches the gate and
  // worker classes this test is about rather than the invalid-cwd class.
  const cwd = cwdOf("projects/repos/demo-repo");
  const cases = [
    {
      input: "{",
      status: 2,
      stdout: "",
      stderr: "",
      expected: /invalid JSON/i,
    },
    {
      input: JSON.stringify({
        ...measured(cwd, "npm test"),
        tool_input: {},
      }),
      status: 2,
      stdout: "",
      stderr: "gate failed at C:\\private\\path",
      expected: /without a string tool_input\.command/i,
    },
    {
      input: JSON.stringify({
        ...measured(cwd, "npm test"),
        hook_event_name: "SessionStart",
      }),
      status: 2,
      stdout: "",
      stderr: "unsupported event",
      expected: /event other than PreToolUse/i,
    },
    {
      input: JSON.stringify(measured(cwd, "npm test")),
      status: 2,
      stdout: "",
      stderr: "resolver failed at C:\\private\\path",
      expected: /failed internally while evaluating/i,
    },
    {
      input: JSON.stringify(measured(cwd, "npm test")),
      status: 1,
      stdout: "",
      stderr: "worker crashed at C:\\private\\path",
      expected: /failed internally while evaluating/i,
    },
    {
      input: JSON.stringify(measured(cwd, "npm test")),
      status: null,
      stdout: "",
      stderr: "",
      signal: "SIGTERM",
      error: { code: "ETIMEDOUT", message: "timed out" },
      expected: /exceeded its time budget/i,
    },
  ];

  for (const item of cases) {
    const stdout: string[] = [];
    const status = runGuardedHook({
      kind: "pre",
      runtime: "codex",
      input: item.input,
      spawn: (() => ({ ...item, signal: item.signal ?? null })) as never,
      stdout: (text) => stdout.push(text),
      stderr: () => {},
    });
    assert.equal(status, 0);
    assert.equal(stdout.length, 1);
    const answer = assertCodexJson({ status, stdout: stdout[0] });
    assert.match(
      answer.hookSpecificOutput.permissionDecisionReason,
      item.expected,
    );
    assert.doesNotMatch(stdout[0], /private|path/i);
  }
});

test("Claude and Copilot retain exit 2 for an ordinary failed PreToolUse worker", () => {
  for (const runtime of ["claude", "copilot"]) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const status = runGuardedHook({
      kind: "pre",
      runtime,
      input: JSON.stringify(measured("C:/w", "npm test")),
      spawn: (() => ({
        status: 2,
        signal: null,
        stdout: "",
        stderr: "failure",
      })) as never,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });
    assert.equal(status, 2);
    assert.deepEqual(stdout, []);
    assert.deepEqual(stderr, ["failure"]);
  }
});

test("the real Codex entry point allows, denies with exact JSON, and fails closed on malformed stdin", () => {
  const allow = spawnSync(process.execPath, [PRE_ENTRY, "codex"], {
    windowsHide: true,
    input: JSON.stringify(measured(repoDir, "npm test")),
    encoding: "utf8",
  });
  assert.equal(allow.status, 0, allow.stderr);
  assert.equal(allow.stdout, "");

  const deny = spawnSync(process.execPath, [PRE_ENTRY, "codex"], {
    windowsHide: true,
    input: JSON.stringify(measured(repoDir, "gh pr merge 1")),
    encoding: "utf8",
  });
  assertCodexJson(deny);
  assert.equal(deny.stdout.trim(), JSON.stringify(JSON.parse(deny.stdout)));

  const malformed = spawnSync(process.execPath, [PRE_ENTRY, "codex"], {
    windowsHide: true,
    input: "{",
    encoding: "utf8",
  });
  assertCodexJson(malformed);
  assert.match(
    JSON.parse(malformed.stdout).hookSpecificOutput.permissionDecisionReason,
    /invalid JSON/i,
  );
});

test("Codex malformed event shapes always produce JSON denial answers", () => {
  const inputs = [
    "null",
    "[]",
    '"x"',
    "42",
    "",
    JSON.stringify({
      ...measured("C:/w", "git push no-such-remote main"),
      tool_input: null,
    }),
    JSON.stringify({
      ...measured("C:/w", "git push no-such-remote main"),
      tool_name: undefined,
    }),
    JSON.stringify({
      ...measured("C:/w", "git push no-such-remote main"),
      tool_name: 42,
    }),
    JSON.stringify({
      ...measured("C:/w", "git push no-such-remote main"),
      cwd: undefined,
    }),
  ];
  for (const input of inputs) {
    const result = spawnSync(process.execPath, [PRE_ENTRY, "codex"], {
      windowsHide: true,
      input,
      encoding: "utf8",
    });
    assertCodexJson(result);
    assert.equal(result.stderr, "");
  }
});

test("Codex rejects non-absolute cwd values with fixed JSON denial answers", () => {
  for (const [cwd, label] of [
    [undefined, "missing"],
    ["", "empty"],
    [42, "non-string"],
    ["projects/repos/demo-repo", "relative"],
    ["C:relative", "relative"],
  ] as const) {
    const input = {
      ...measured(
        cwdOf("projects/repos/demo-repo"),
        "git push no-such-remote main",
      ),
      cwd,
    };
    const result = spawnSync(process.execPath, [PRE_ENTRY, "codex"], {
      windowsHide: true,
      input: JSON.stringify(input),
      encoding: "utf8",
    });
    const answer = assertCodexJson(result);
    assert.match(
      answer.hookSpecificOutput.permissionDecisionReason,
      new RegExp(label, "i"),
    );
  }
  assert.throws(
    () =>
      normalizeCall(
        measured("relative/path", "git push no-such-remote main"),
        "linux",
      ),
    /relative cwd/i,
  );
});

test("PowerShell reads a leading call operator as the program it runs", async (t) => {
  const plain = await decide(
    measured(cwdOf("projects/repos/demo-repo"), "git push no-such-remote main"),
    "read",
    "win32",
  );
  assert.equal(plain?.hookSpecificOutput.permissionDecision, "deny");
  for (const command of [
    "& git push no-such-remote main",
    "& 'git' push no-such-remote main",
    '& "git" push no-such-remote main',
    String.raw`& 'C:\Program Files\Git\cmd\git.exe' push no-such-remote main`,
  ]) {
    await t.test(command, async () => {
      assert.deepEqual(
        await decide(
          measured(cwdOf("projects/repos/demo-repo"), command),
          "read",
          "win32",
        ),
        plain,
        command,
      );
    });
  }
});

test("PowerShell decides an assignment, a separator, and a pipeline by the first word", async (t) => {
  for (const command of [
    "$x = git rev-parse HEAD; Write-Output $x",
    "$sha = (git rev-parse HEAD).Trim()",
    "git status | Out-String",
    "git log --oneline | Select-String push",
  ]) {
    await t.test(command, async () => {
      assert.equal(
        await decide(
          measured(cwdOf("projects/repos/demo-repo"), command),
          "read",
          "win32",
        ),
        null,
        command,
      );
    });
  }
});

test("PowerShell does not treat quoted text, comments, or search patterns as commands", async () => {
  for (const command of [
    'echo "git push no-such-remote main"',
    "# git push no-such-remote main",
    "Write-Output 'git push'",
    'git log --grep="push upstream main"',
    "Select-String -Pattern 'git push'",
  ]) {
    assert.equal(
      await decide(
        measured(cwdOf("projects/repos/demo-repo"), command),
        "read",
        "win32",
      ),
      null,
      command,
    );
  }
});

test("POSIX dialect keeps the established shell-reader decisions for equivalent syntax", async () => {
  const cases = [
    ["'git' push no-such-remote main", "deny"],
    ['"git" push no-such-remote main', "deny"],
    ["command git push no-such-remote main", "allow"],
    ["env X=1 git push no-such-remote main", "allow"],
    ['eval "git push no-such-remote main"', "allow"],
    ['sh -c "git push no-such-remote main"', "allow"],
    ["(git push no-such-remote main)", "allow"],
    ["$(git push no-such-remote main)", "allow"],
    ["`git push no-such-remote main`", "allow"],
    ["echo safe | git push no-such-remote main", "allow"],
    ["git status; git push no-such-remote main", "allow"],
    ["git status && git push no-such-remote main", "allow"],
    ["git status || git push no-such-remote main", "allow"],
    ["echo safe | xargs git push no-such-remote main", "allow"],
    ["FOO=1 git push no-such-remote main", "allow"],
    ["git pu`sh no-such-remote main", "allow"],
  ] as const;
  const { decideShell } = await import("../gate.mjs");
  for (const [command, expected] of cases) {
    const answer = decideShell(
      { command, shell: "bash" },
      {
        cwd: cwdOf("projects/repos/demo-repo"),
        lookup: () => ({ repo: "demo-repo" }),
        resolve: (_repo, text) => {
          const words = tokenize(text, "bash");
          return words[0] === "git" && words[1] === "push"
            ? { code: 1, stdout: JSON.stringify({ level: "read" }) }
            : { code: 0, stdout: JSON.stringify({ level: "read" }) };
        },
        remoteUrl: () => null,
      },
    );
    assert.equal(
      answer.action === "deny" ? "deny" : "allow",
      expected,
      command,
    );
  }
});

test("resolver unknown distinguishes an absent catalog entry from resolver failure", async () => {
  const { decideShell } = await import("../gate.mjs");
  const input = { command: "git push no-such-remote main" };
  const decision = decideShell(input, {
    cwd: cwdOf("projects/repos/demo-repo"),
    lookup: () => ({ repo: "demo-repo" }),
    resolve: () => ({ code: 2, stdout: "" }),
    remoteUrl: () => null,
  });
  assert.match(decision.reason ?? "", /resolver could not answer/i);
  const missing = decideShell(input, {
    cwd: cwdOf("projects/repos/demo-repo"),
    lookup: () => ({ repo: "demo-repo" }),
    resolve: () => ({ code: 2, stdout: "", catalogMissing: true }),
    remoteUrl: () => null,
  });
  assert.match(missing.reason ?? "", /not in the fleet catalog/i);
});

test("Codex worker-start failures produce JSON denial with exit 0", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const status = runGuardedHook({
    kind: "pre",
    runtime: "codex",
    input: JSON.stringify(measured("C:/w", "git push no-such-remote main")),
    spawn: (() => ({
      status: null,
      signal: null,
      stdout: "",
      stderr: "",
      error: { code: "ENOENT", message: "not found" },
    })) as never,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  assert.equal(status, 0);
  assert.equal(stderr.length, 0);
  assertCodexJson({ status, stdout: stdout[0] });
});

test("Codex stdout writer keeps a large JSON line complete before process exit", () => {
  const payload = JSON.stringify({ reason: "x".repeat(256 * 1024) });
  const source = `import { writeStdout } from ${JSON.stringify(new URL("../hooks/lib/codex.mjs", import.meta.url).href)}; writeStdout(JSON.stringify({reason:"x".repeat(256*1024)})+"\\n"); process.exit(0);`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source],
    {
      windowsHide: true,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${payload}\n`);
});

test("Codex handles a closed stdout pipe quietly and exits zero", async () => {
  const moduleUrl = new URL("../hooks/lib/codex.mjs", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { writeStdout } from ${JSON.stringify(moduleUrl)}; writeStdout("x".repeat(32*1024*1024));`,
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.once("data", () => child.stdout.destroy());
  const [code, signal] = await new Promise<
    [number | null, NodeJS.Signals | null]
  >((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, exitSignal) =>
      resolveExit([exitCode, exitSignal]),
    );
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Codex EPIPE probe timed out"));
    }, 10_000);
    child.once("close", () => clearTimeout(timeout));
  });
  assert.equal(signal, null);
  assert.equal(code, 0, stderr);
  assert.match(
    stderr,
    /denial could not be delivered because stdout is closed/i,
  );
});
