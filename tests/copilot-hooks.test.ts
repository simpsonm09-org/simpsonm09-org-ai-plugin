// The GitHub Copilot CLI hooks (hooks/lib/copilot.mjs, selected by the `copilot` argument of the
// hook entry points). The decision is the shared one (gate.mjs) through the Claude adapter; these
// tests cover the Copilot wire format: the two payload shapes, the output keys, the PowerShell
// rewrite, the exit codes, and the fail-closed paths. Everything runs against the fixture
// workspace and stubs; nothing reaches GitHub.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { decodePayload } from "../bin/payload.mjs";
import { contextLine } from "../gate.mjs";
import {
  budgetAnswer,
  handlePreToolUse,
  handleSessionStart,
  normalizeCall,
} from "../hooks/lib/copilot.mjs";
import { runGuardedHook } from "../hooks/lib/entry.mjs";
import { runtimeNamed } from "../hooks/lib/runtime.mjs";
import {
  buildWorkspace,
  removeDir,
  tempDir,
  writeCatalog,
} from "./support/fixture-workspace.mjs";

// A PreToolUse answer that rewrites the arguments.
type Rewrite = {
  permissionDecision: string;
  modifiedArgs: { command: string; description?: string };
};

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_ENV = { CLAUDE_CODE_GIT_BASH_PATH: process.execPath };
const PRE_ENTRY = join(repoDir, "hooks", "pre-tool-use.mjs");
const SESSION_ENTRY = join(repoDir, "hooks", "session-start.mjs");

let ws = "";
const cwdOf = (rel: string) => join(ws, ...rel.split("/"));
const DEMO = "projects/repos/demo-repo";

before(() => {
  ws = tempDir("copilot-hooks-");
  buildWorkspace(ws, { level: "read" });
});

after(() => {
  if (ws) removeDir(ws);
});

// The Copilot payload. `copilot` is the camelCase preToolUse shape (toolName, toolArgs, with the
// lowercase Copilot tool names); `pascal` is the PascalCase shape (tool_name, tool_input, with
// Claude's names). Both carry cwd.
function payload(
  tool: "bash" | "powershell",
  command: string,
  cwd: string | undefined,
  shape: "copilot" | "pascal" = "copilot",
) {
  const args = { command, description: "d" };
  const base =
    shape === "copilot"
      ? { toolName: tool, toolArgs: args }
      : {
          tool_name: tool === "bash" ? "Bash" : "PowerShell",
          tool_input: args,
        };
  return cwd === undefined ? base : { ...base, cwd };
}

function decide(input: unknown, level = "read") {
  writeCatalog(ws, level);
  return handlePreToolUse(input, { workspaceRoot: ws, env: TOKEN_ENV });
}

// The exact keys of a Copilot deny: nothing else is allowed.
function denied(out: Record<string, unknown> | null) {
  assert.ok(out, "expected a deny, got no answer");
  assert.deepEqual(Object.keys(out).sort(), [
    "permissionDecision",
    "permissionDecisionReason",
  ]);
  assert.equal(out.permissionDecision, "deny");
  return String(out.permissionDecisionReason);
}

// The payload the rewrite carries. It is the last single-quoted base64 piece of the command.
function rewrittenPayload(command: string) {
  const match = /'([A-Za-z0-9+/=]+)'\s*$/.exec(command);
  assert.ok(match, `no base64 payload at the end of: ${command}`);
  return decodePayload(match[1]);
}

const WRITE_COPILOT = JSON.stringify(
  payload("bash", "git push origin main", undefined),
);
const READ_COPILOT = JSON.stringify(payload("bash", "ls", undefined));

test("a push to the organization main is denied from the Copilot bash and PowerShell tools, in both payload shapes", async () => {
  for (const tool of ["bash", "powershell"] as const) {
    for (const shape of ["copilot", "pascal"] as const) {
      const out = await decide(
        payload(tool, "git push origin main", cwdOf(DEMO), shape),
        "propose",
      );
      const reason = denied(out);
      assert.match(
        reason,
        /agent-access: denied: demo-repo denies this command at level "propose"/,
        `${tool} ${shape}`,
      );
    }
  }
});

test("a push with a PowerShell-quoted remote, and a dry run of a push to the org main, are denied through PowerShell", async () => {
  denied(
    await decide(
      payload("powershell", "git push 'origin' main", cwdOf(DEMO)),
      "propose",
    ),
  );
  // The fixture's origin is the organization URL, so a dry run of a push to it is still a push.
  denied(
    await decide(
      payload("powershell", "git push --dry-run origin HEAD:main", cwdOf(DEMO)),
      "propose",
    ),
  );
});

test("a push to a branch on the organization remote that the level allows passes untouched", async () => {
  assert.equal(
    await decide(
      payload("bash", "git push origin feat/x", cwdOf(DEMO)),
      "propose",
    ),
    null,
  );
  assert.equal(
    await decide(
      payload("powershell", "git push origin feat/x", cwdOf(DEMO)),
      "propose",
    ),
    null,
  );
});

test("a command outside the fleet passes untouched, even a push to main", async () => {
  assert.equal(
    await decide(
      payload("bash", "git push origin main", cwdOf("projects/other/x")),
      "propose",
    ),
    null,
  );
  assert.equal(
    await decide(
      payload("powershell", "git push origin main", cwdOf("projects/other/x")),
      "propose",
    ),
    null,
  );
});

test("a call to a tool the gate does not govern passes, and so does a command that is not a write", async () => {
  assert.equal(
    await decide({
      toolName: "view",
      toolArgs: { path: "x" },
      cwd: cwdOf(DEMO),
    }),
    null,
  );
  assert.equal(await decide(payload("bash", "npm test", cwdOf(DEMO))), null);
  assert.equal(
    await decide(payload("powershell", "npm test", cwdOf(DEMO))),
    null,
  );
});

test("a write with no working directory is denied, and a read with none passes", async () => {
  denied(await decide(payload("bash", "git push origin main", undefined)));
  assert.equal(await decide(payload("bash", "ls", undefined)), null);
});

test("a malformed payload is an error, never a pass", async () => {
  await assert.rejects(
    handlePreToolUse(null, { workspaceRoot: ws }),
    /not an object/,
  );
  await assert.rejects(
    handlePreToolUse({}, { workspaceRoot: ws }),
    /names no tool/,
  );
  await assert.rejects(
    handlePreToolUse(
      { toolName: "bash", toolArgs: {}, cwd: cwdOf(DEMO) },
      { workspaceRoot: ws },
    ),
    /no command string/,
  );
  await assert.rejects(
    handlePreToolUse(
      {
        toolName: "powershell",
        toolArgs: "git push origin main",
        cwd: cwdOf(DEMO),
      },
      { workspaceRoot: ws },
    ),
    /no command string/,
  );
});

test("the PreToolUse entry point denies a malformed payload by exiting 2, with the reason on stderr", () => {
  for (const input of [
    "{",
    "{}",
    JSON.stringify({ toolName: "bash", toolArgs: {} }),
  ]) {
    const result = spawnSync(process.execPath, [PRE_ENTRY, "copilot"], {
      input,
      encoding: "utf8",
    });
    assert.equal(result.status, 2, input);
    assert.match(result.stderr, /so the command is blocked/);
    assert.equal(result.stdout, "");
  }
});

test("the PreToolUse entry point answers a Copilot deny as JSON on stdout with exit 0", () => {
  const result = spawnSync(process.execPath, [PRE_ENTRY, "copilot"], {
    input: JSON.stringify(
      payload("powershell", "git push origin main", undefined),
    ),
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  const out = JSON.parse(result.stdout);
  assert.equal(out.permissionDecision, "deny");
  assert.deepEqual(Object.keys(out).sort(), [
    "permissionDecision",
    "permissionDecisionReason",
  ]);
});

test("a PreToolUse entry point started with an unknown runtime fails closed", () => {
  const result = spawnSync(process.execPath, [PRE_ENTRY, "nonsense"], {
    input: READ_COPILOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /so the command is blocked/);
});

test("a PowerShell gh read is rewritten through the launcher in PowerShell form, with the command carried intact", async () => {
  const command = "gh api user --jq .login";
  const out = (await decide(
    payload("powershell", command, cwdOf(DEMO)),
  )) as Rewrite;
  assert.equal(out.permissionDecision, "allow");
  assert.deepEqual(Object.keys(out).sort(), [
    "modifiedArgs",
    "permissionDecision",
    "permissionDecisionReason",
  ]);
  const line: string = out.modifiedArgs.command;
  assert.match(
    line,
    /^& '[^']*node[^']*' '[^']*with-gh-token\.mjs' '[A-Za-z0-9+/=]+'$/,
  );
  assert.equal(
    out.modifiedArgs.description,
    "d",
    "every other argument is carried over",
  );
  assert.deepEqual(rewrittenPayload(line), {
    workspace: ws,
    repo: "demo-repo",
    command,
    shell: "powershell",
  });
});

test("a PowerShell gh read with quotes, spaces, and a doubled single quote keeps the typed command exactly", async () => {
  const command = `gh search prs 'it''s a "test"' --jq .items`;
  const out = (await decide(
    payload("powershell", command, cwdOf(DEMO)),
  )) as Rewrite;
  assert.equal(out.permissionDecision, "allow");
  assert.equal(rewrittenPayload(out.modifiedArgs.command).command, command);
});

test("a PowerShell gh write is asked for, through the launcher, at a level that allows it", async () => {
  const out = (await decide(
    payload("powershell", "gh pr create --title x", cwdOf(DEMO)),
    "full",
  )) as Rewrite;
  assert.equal(out.permissionDecision, "ask");
  assert.match(out.modifiedArgs.command, /with-gh-token\.mjs'/);
});

test("a PowerShell gh write is denied at a level that does not allow it", async () => {
  denied(
    await decide(payload("powershell", "gh pr merge 1", cwdOf(DEMO)), "read"),
  );
});

test("a bash gh read from the Copilot bash tool is rewritten in POSIX form", async () => {
  const out = (await decide(
    payload("bash", "gh api user --jq .login", cwdOf(DEMO)),
  )) as Rewrite;
  assert.equal(out.permissionDecision, "allow");
  assert.match(
    out.modifiedArgs.command,
    /^'[^']*node[^']*' '[^']*with-gh-token\.mjs' '[A-Za-z0-9+/=]+'$/,
  );
  assert.deepEqual(rewrittenPayload(out.modifiedArgs.command), {
    workspace: ws,
    repo: "demo-repo",
    command: "gh api user --jq .login",
  });
});

test("the Claude adapter still denies a PowerShell gh call and says to use Bash", async () => {
  const { handlePreToolUse: claudePre } = await import(
    "../hooks/lib/claude.mjs"
  );
  writeCatalog(ws, "read");
  const out = await claudePre(
    {
      tool_name: "PowerShell",
      cwd: cwdOf(DEMO),
      tool_input: { command: "gh api user --jq .login" },
    },
    { workspaceRoot: ws, env: TOKEN_ENV },
  );
  assert.equal(out?.hookSpecificOutput.permissionDecision, "deny");
  assert.match(
    out?.hookSpecificOutput.permissionDecisionReason,
    /run this gh command with Bash, not PowerShell/,
  );
});

test("the SessionStart answer is additionalContext only, for a fleet repository, and nothing elsewhere", async () => {
  writeCatalog(ws, "propose");
  assert.deepEqual(
    await handleSessionStart(
      { sessionId: "s", cwd: cwdOf(DEMO), source: "startup" },
      { workspaceRoot: ws },
    ),
    { additionalContext: contextLine("demo-repo", "propose") },
  );
  assert.equal(
    await handleSessionStart(
      { cwd: cwdOf("projects/other/x") },
      { workspaceRoot: ws },
    ),
    null,
  );
});

test("the SessionStart entry point never blocks, and prints nothing for a malformed payload", () => {
  const result = spawnSync(process.execPath, [SESSION_ENTRY, "copilot"], {
    input: "{",
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("a killed Copilot PreToolUse worker denies a write in Copilot's shape and passes a read", () => {
  const killed = {
    error: { code: "ETIMEDOUT", message: "spawnSync ETIMEDOUT" },
    signal: "SIGTERM",
    status: null,
  };
  const spawn = (() => ({
    status: 0,
    signal: null,
    stdout: "",
    stderr: "",
    ...killed,
  })) as never;

  const write: string[] = [];
  assert.equal(
    runGuardedHook({
      kind: "pre",
      runtime: "copilot",
      input: WRITE_COPILOT,
      spawn,
      stdout: (t) => write.push(t),
      stderr: () => {},
    }),
    0,
  );
  const answer = JSON.parse(write[0]);
  assert.equal(answer.permissionDecision, "deny");
  assert.deepEqual(Object.keys(answer).sort(), [
    "permissionDecision",
    "permissionDecisionReason",
  ]);

  const read: string[] = [];
  runGuardedHook({
    kind: "pre",
    runtime: "copilot",
    input: READ_COPILOT,
    spawn,
    stdout: (t) => read.push(t),
    stderr: () => {},
  });
  assert.deepEqual(read, []);
});

test("a Copilot PreToolUse worker that cannot be read is a deny, and an unknown runtime throws before a worker starts", () => {
  const budget = budgetAnswer(undefined, { blockOnError: true }) as Record<
    string,
    unknown
  >;
  assert.equal(budget.permissionDecision, "deny");
  assert.equal(
    budgetAnswer({ toolName: "view" }, { blockOnError: false }),
    null,
  );
  assert.throws(
    () => runtimeNamed("nonsense"),
    /unknown hook runtime "nonsense"/,
  );
  assert.throws(
    () =>
      runGuardedHook({
        kind: "pre",
        runtime: "nonsense",
        input: READ_COPILOT,
        spawn: (() => {
          throw new Error("spawned");
        }) as never,
        stdout: () => {},
        stderr: () => {},
      }),
    /unknown hook runtime/,
  );
});

test("normalizeCall reads both payload shapes into the same call, and maps the tool names", () => {
  assert.deepEqual(normalizeCall(payload("powershell", "x", "/w")), {
    tool_name: "PowerShell",
    tool_input: { command: "x", description: "d" },
    cwd: "/w",
  });
  assert.deepEqual(
    normalizeCall(payload("bash", "x", "/w", "pascal")).tool_name,
    "Bash",
  );
  assert.equal(normalizeCall({ toolName: "view" }).tool_name, "view");
});
