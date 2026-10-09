// The Copilot ask switch (AGENT_ACCESS_COPILOT_ASK). Under a session where no one can answer a
// prompt, the gate's `ask` for a permitted gh write becomes `allow` when the hook process was
// started with the switch set to exactly "allow". Denials are unchanged, and the access level still
// decides what is permitted. The switch is read from the hook process environment only, and the
// Claude path ignores it. Fixture workspace and stubs only: nothing reaches GitHub.

import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { handlePreToolUse as claudePreToolUse } from "../hooks/lib/claude.mjs";
import {
  ASK_VARIABLE,
  askIsAllowed,
  handlePreToolUse,
} from "../hooks/lib/copilot.mjs";
import {
  buildWorkspace,
  removeDir,
  tempDir,
  writeCatalog,
} from "./support/fixture-workspace.mjs";

const TOKEN_ENV = { CLAUDE_CODE_GIT_BASH_PATH: process.execPath };

let ws = "";
let demo = "";
const cwdOf = (rel: string) => join(ws, ...rel.split("/"));

before(() => {
  ws = tempDir("copilot-ask-mode-");
  buildWorkspace(ws, { level: "read" });
  demo = cwdOf("projects/repos/demo-repo");
});

after(() => {
  if (ws) removeDir(ws);
});

// Runs fn with the hook process's switch set to value (or unset), and restores it afterwards.
async function withSwitch<T>(value: string | undefined, fn: () => Promise<T>) {
  const saved = process.env[ASK_VARIABLE];
  if (value === undefined) delete process.env[ASK_VARIABLE];
  else process.env[ASK_VARIABLE] = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[ASK_VARIABLE];
    else process.env[ASK_VARIABLE] = saved;
  }
}

// A native Copilot call, as the hook receives it.
function call(tool: "bash" | "powershell", command: string, cwd = demo) {
  return {
    sessionId: "7c1f0e52-2a8d-4f0e-9b1a-3d2c5e6f7a81",
    timestamp: 1791497823611,
    cwd,
    toolName: tool,
    toolArgs: { command, description: "d" },
  };
}

function answer(tool: "bash" | "powershell", command: string, level = "read") {
  writeCatalog(ws, level);
  return handlePreToolUse(call(tool, command), {
    workspaceRoot: ws,
    env: TOKEN_ENV,
  }) as Promise<{
    permissionDecision: string;
    permissionDecisionReason?: string;
    modifiedArgs?: Record<string, string>;
  } | null>;
}

const PERMITTED_WRITE = "gh pr create --title x";

test("with the switch unset, a permitted gh write is asked for, through the launcher", async () => {
  const out = await withSwitch(undefined, () =>
    answer("powershell", PERMITTED_WRITE, "full"),
  );
  assert.equal(out?.permissionDecision, "ask");
  assert.match(out?.modifiedArgs?.command ?? "", /with-gh-token\.mjs'/);
});

test("with the switch set to allow, the same permitted gh write is allowed, with the same rewrite and reason", async () => {
  const asked = await withSwitch(undefined, () =>
    answer("powershell", PERMITTED_WRITE, "full"),
  );
  const allowed = await withSwitch("allow", () =>
    answer("powershell", PERMITTED_WRITE, "full"),
  );
  assert.equal(allowed?.permissionDecision, "allow");
  assert.equal(
    allowed?.permissionDecisionReason,
    asked?.permissionDecisionReason,
  );
  assert.deepEqual(allowed?.modifiedArgs, asked?.modifiedArgs);
  assert.match(allowed?.modifiedArgs?.command ?? "", /with-gh-token\.mjs'/);
  assert.deepEqual(Object.keys(allowed ?? {}).sort(), [
    "modifiedArgs",
    "permissionDecision",
    "permissionDecisionReason",
  ]);
});

test("with the switch set to allow, a gh write above the level is still denied, with the same answer as unset", async () => {
  const unset = await withSwitch(undefined, () =>
    answer("powershell", "gh pr merge 1", "read"),
  );
  const allowed = await withSwitch("allow", () =>
    answer("powershell", "gh pr merge 1", "read"),
  );
  assert.equal(allowed?.permissionDecision, "deny");
  assert.deepEqual(allowed, unset);
});

test("with the switch set to allow, a push to the organization main is still denied at propose", async () => {
  const out = await withSwitch("allow", () =>
    answer("powershell", "git push origin main", "propose"),
  );
  assert.equal(out?.permissionDecision, "deny");
  assert.match(
    out?.permissionDecisionReason ?? "",
    /denies this command at level "propose"/,
  );
});

test("a launcher line that wraps a non-gh command is denied with or without the switch", async () => {
  // A launcher line whose payload carries a plain branch push. The hook discards the node and
  // launcher paths, so they need only the line's shape.
  const payload = Buffer.from(
    JSON.stringify({ command: "git push origin feat/x" }),
    "utf8",
  ).toString("base64");
  const payloadLine = `& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\with-gh-token.mjs' '${payload}'`;

  const unset = await withSwitch(undefined, () =>
    answer("powershell", payloadLine, "propose"),
  );
  const allowed = await withSwitch("allow", () =>
    answer("powershell", payloadLine, "propose"),
  );
  assert.equal(unset?.permissionDecision, "deny");
  assert.equal(unset?.modifiedArgs, undefined);
  assert.deepEqual(allowed, unset);
});

test("a gh read is allowed with the switch unset and with it set, and its rewrite is the same", async () => {
  const unset = await withSwitch(undefined, () =>
    answer("powershell", "gh api user --jq .login", "read"),
  );
  const allowed = await withSwitch("allow", () =>
    answer("powershell", "gh api user --jq .login", "read"),
  );
  assert.equal(unset?.permissionDecision, "allow");
  assert.deepEqual(allowed, unset);
});

test("only the exact value allow turns an ask into an allow", async () => {
  for (const value of [
    "true",
    "1",
    "ALLOW",
    "Allow",
    "allow ",
    " allow",
    "yes",
    "",
  ]) {
    const out = await withSwitch(value, () =>
      answer("powershell", PERMITTED_WRITE, "full"),
    );
    assert.equal(
      out?.permissionDecision,
      "ask",
      `value ${JSON.stringify(value)}`,
    );
  }
});

test("the switch is read from the hook process environment, and askIsAllowed follows it", async () => {
  await withSwitch(undefined, async () => {
    assert.equal(askIsAllowed(), false);
  });
  await withSwitch("allow", async () => {
    assert.equal(askIsAllowed(), true);
  });
  assert.equal(askIsAllowed({ [ASK_VARIABLE]: "allow" }), true);
  assert.equal(askIsAllowed({ [ASK_VARIABLE]: "deny" }), false);
});

test("the agent cannot set the switch: options.env and the tool arguments do not change the answer", async () => {
  // options.env is the hook's own environment for the Git Bash lookup; the answer ignores it.
  writeCatalog(ws, "full");
  const viaOptions = await withSwitch(undefined, () =>
    handlePreToolUse(call("powershell", PERMITTED_WRITE, demo), {
      workspaceRoot: ws,
      env: { ...TOKEN_ENV, [ASK_VARIABLE]: "allow" },
    }),
  );
  assert.equal(
    (viaOptions as { permissionDecision: string }).permissionDecision,
    "ask",
  );

  // A tool argument named like the switch is an argument, not the environment.
  const viaArgs = await withSwitch(undefined, () =>
    handlePreToolUse(
      {
        ...call("powershell", PERMITTED_WRITE, demo),
        toolArgs: {
          command: PERMITTED_WRITE,
          description: "d",
          env: { [ASK_VARIABLE]: "allow" },
        },
      },
      { workspaceRoot: ws, env: TOKEN_ENV },
    ),
  );
  assert.equal(
    (viaArgs as { permissionDecision: string }).permissionDecision,
    "ask",
  );
});

test("the Claude path ignores the switch: its gh write is still asked", async () => {
  writeCatalog(ws, "full");
  const out = await withSwitch("allow", () =>
    claudePreToolUse(
      {
        tool_name: "Bash",
        cwd: demo,
        tool_input: { command: PERMITTED_WRITE },
      },
      { workspaceRoot: ws, env: TOKEN_ENV },
    ),
  );
  assert.equal(out?.hookSpecificOutput.permissionDecision, "ask");
});
