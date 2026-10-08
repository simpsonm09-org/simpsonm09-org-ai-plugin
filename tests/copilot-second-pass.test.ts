// A second pass over the hook's own rewrite. Copilot can run the PreToolUse hook on a command it
// has already rewritten, and then that command is this plugin's launcher line. The hook allows it
// only when the line is byte-for-byte the rewrite it gives the payload's command in this call's
// directory. Every other launcher line keeps the launcher denial. Fixture workspace and stubs
// only: nothing reaches GitHub.

import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { decodePayload } from "../bin/payload.mjs";
import {
  handlePreToolUse as claudePreToolUse,
  launcherCommand,
  ownLinePayload,
  powershellLauncherCommand,
} from "../hooks/lib/claude.mjs";
import { handlePreToolUse } from "../hooks/lib/copilot.mjs";
import {
  buildWorkspace,
  removeDir,
  tempDir,
  writeCatalog,
} from "./support/fixture-workspace.mjs";

const TOKEN_ENV = { CLAUDE_CODE_GIT_BASH_PATH: process.execPath };
const LAUNCHER_DENIAL =
  "agent-access: denied: the GitHub token launcher is not for direct use";

// The line the hook emitted in the live run that showed the bug, verbatim. Its workspace and
// launcher are the live machine's, so it is recognised by shape here and denied by its payload.
const LIVE_SECOND_PASS =
  "& 'C:\\Program Files\\nodejs\\node.exe' 'D:\\dev\\simpsonm09\\projects\\worktrees\\simpsonm09-org-ai-plugin-copilot\\bin\\with-gh-token.mjs' 'eyJ3b3Jrc3BhY2UiOiJEOlxcZGV2XFxzaW1wc29ubTA5IiwicmVwbyI6InNpbXBzb25tMDktbWF4c3RhY2siLCJjb21tYW5kIjoiZ2ggYXBpIHJlcG9zL3NpbXBzb25tMDktb3JnL3NpbXBzb25tMDktbWF4c3RhY2sgLS1qcSAuZGVmYXVsdF9icmFuY2giLCJzaGVsbCI6InBvd2Vyc2hlbGwifQ=='";

let ws = "";
let demo = "";
const cwdOf = (rel: string) => join(ws, ...rel.split("/"));

before(() => {
  ws = tempDir("copilot-second-pass-");
  buildWorkspace(ws, { level: "read" });
  demo = cwdOf("projects/repos/demo-repo");
});

after(() => {
  if (ws) removeDir(ws);
});

// A native Copilot call, as the hook receives it.
function call(
  tool: "bash" | "powershell",
  command: string,
  cwd: string = demo,
) {
  return {
    sessionId: "7c1f0e52-2a8d-4f0e-9b1a-3d2c5e6f7a81",
    timestamp: 1791497823611,
    cwd,
    toolName: tool,
    toolArgs: { command, description: "d" },
  };
}

// The hook's answer for one call at a level.
function answer(
  tool: "bash" | "powershell",
  command: string,
  level = "read",
  cwd: string = demo,
) {
  writeCatalog(ws, level);
  return handlePreToolUse(call(tool, command, cwd), {
    workspaceRoot: ws,
    env: TOKEN_ENV,
  }) as Promise<
    Record<string, unknown> & { modifiedArgs?: { command: string } }
  >;
}

// The payload the hook would write for this fixture: the demo repo in this workspace.
const payload = (over: Record<string, unknown> = {}) => ({
  workspace: ws,
  repo: "demo-repo",
  command: "gh api user --jq .login",
  shell: "powershell",
  ...over,
});

// The line for a payload in the given dialect, built the way the hook builds its rewrite.
const psLine = (over: Record<string, unknown> = {}, launcher?: string) =>
  powershellLauncherCommand(
    payload(over) as Parameters<typeof powershellLauncherCommand>[0],
    launcher,
  );
const bashLine = (over: Record<string, unknown> = {}, launcher?: string) =>
  launcherCommand(
    {
      workspace: ws,
      repo: "demo-repo",
      command: "gh api user --jq .login",
      ...over,
    } as Parameters<typeof launcherCommand>[0],
    launcher,
  );

function assertDenied(
  out: Record<string, unknown> | null,
  reason = LAUNCHER_DENIAL,
) {
  assert.ok(out, "expected a denial");
  assert.deepEqual(Object.keys(out).sort(), [
    "permissionDecision",
    "permissionDecisionReason",
  ]);
  assert.equal(out.permissionDecision, "deny");
  assert.equal(out.permissionDecisionReason, reason);
}

test("the hook's own PowerShell rewrite, sent back, is allowed unchanged, with no modifiedArgs", async () => {
  const first = await answer(
    "powershell",
    "gh api repos/simpsonm09-org/simpsonm09-maxstack --jq .default_branch",
  );
  assert.equal(first.permissionDecision, "allow");
  const again = await answer(
    "powershell",
    first.modifiedArgs?.command as string,
  );
  assert.deepEqual(Object.keys(again).sort(), [
    "permissionDecision",
    "permissionDecisionReason",
  ]);
  assert.equal(again.permissionDecision, "allow");
});

test("the hook's own Bash rewrite, sent back, is allowed unchanged, with no modifiedArgs", async () => {
  const first = await answer("bash", "gh api user --jq .login");
  const again = await answer("bash", first.modifiedArgs?.command as string);
  assert.deepEqual(Object.keys(again).sort(), [
    "permissionDecision",
    "permissionDecisionReason",
  ]);
  assert.equal(again.permissionDecision, "allow");
});

test("a write's own rewrite, sent back, keeps the first pass's decision: ask, with no modifiedArgs", async () => {
  const first = await answer("powershell", "gh pr create --title x", "full");
  assert.equal(first.permissionDecision, "ask");
  const again = await answer(
    "powershell",
    first.modifiedArgs?.command as string,
    "full",
  );
  assert.equal(again.permissionDecision, "ask");
  assert.equal("modifiedArgs" in again, false);
});

test("the live line from the bug report is recognised by shape, and its payload names simpsonm09-maxstack", () => {
  const base64 = ownLinePayload(LIVE_SECOND_PASS, "powershell");
  assert.ok(base64, "the live line has the launcher shape");
  assert.deepEqual(decodePayload(base64 as string), {
    workspace: "D:\\dev\\simpsonm09",
    repo: "simpsonm09-maxstack",
    command:
      "gh api repos/simpsonm09-org/simpsonm09-maxstack --jq .default_branch",
    shell: "powershell",
  });
});

test("the live line is denied in this fixture, because its workspace and launcher are not this checkout's", async () => {
  // The hook rewrites from its own workspace, so the live line's payload cannot match.
  assertDenied(await answer("powershell", LIVE_SECOND_PASS));
});

test("a payload that names another repo is denied", async () => {
  assertDenied(await answer("powershell", psLine({ repo: "fork-repo" })));
});

test("a payload whose command is a denied push to the organization main is denied", async () => {
  assertDenied(
    await answer(
      "powershell",
      psLine({ command: "git push origin main" }),
      "propose",
    ),
  );
});

test("a payload whose command is a gh write above the level is denied", async () => {
  assertDenied(
    await answer("powershell", psLine({ command: "gh pr merge 1" }), "read"),
  );
});

test("a payload whose command the gate does not rewrite is denied, including one outside the fleet", async () => {
  // A plain command is not rewritten, so the line for it is not the hook's rewrite of anything.
  assertDenied(await answer("powershell", psLine({ command: "npm test" })));
  assertDenied(
    await answer("powershell", psLine(), "read", cwdOf("projects/other/x")),
  );
});

test("a PowerShell launcher line with a trailing command is denied", async () => {
  assertDenied(
    await answer("powershell", `${psLine()}; git push upstream main`),
  );
});

test("a Bash launcher line with a trailing command is denied", async () => {
  assertDenied(await answer("bash", `${bashLine()} && git push upstream main`));
});

test("a launcher line with a different launcher path is denied", async () => {
  assertDenied(
    await answer(
      "powershell",
      psLine({}, "D:/elsewhere/bin/with-gh-token.mjs"),
    ),
  );
  assertDenied(
    await answer("bash", bashLine({}, "/elsewhere/bin/with-gh-token.mjs")),
  );
});

test("a tampered base64 payload is denied", async () => {
  const line = psLine();
  const base64 = ownLinePayload(line, "powershell") as string;
  // Change one character, keeping the alphabet, so the line keeps its shape.
  const flipped =
    base64.slice(0, 8) + (base64[8] === "A" ? "B" : "A") + base64.slice(9);
  assertDenied(await answer("powershell", line.replace(base64, flipped)));
});

test("a base64 argument that is not base64, or that decodes to no payload, is denied", async () => {
  assertDenied(
    await answer(
      "powershell",
      `& 'C:/node.exe' 'C:/with-gh-token.mjs' 'not base64!'`,
    ),
  );
  const notAPayload = Buffer.from("not json", "utf8").toString("base64");
  assertDenied(
    await answer(
      "powershell",
      `& 'C:/node.exe' 'C:/with-gh-token.mjs' '${notAPayload}'`,
    ),
  );
});

test("a PowerShell launcher line sent as the Bash tool, or a Bash line sent as PowerShell, is denied", async () => {
  assertDenied(await answer("bash", psLine()));
  assertDenied(await answer("powershell", bashLine()));
});

test("the Claude path still denies any launcher line, and does not recognise its own rewrite", async () => {
  writeCatalog(ws, "read");
  const out = await claudePreToolUse(
    {
      tool_name: "PowerShell",
      cwd: demo,
      tool_input: { command: psLine() },
    },
    { workspaceRoot: ws, env: TOKEN_ENV },
  );
  assert.equal(out?.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(
    out?.hookSpecificOutput.permissionDecisionReason,
    LAUNCHER_DENIAL,
  );
});
