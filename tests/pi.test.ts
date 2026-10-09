// The Pi adapter (hooks/lib/pi.mjs). The decision is the shared one (gate.mjs), reached through
// the Claude adapter; these tests cover the mapping onto Pi's tool_call answer: a block, a
// rewritten command, the ask prompt, and the fail-closed paths. Pi is not run. The handler is
// called with the event Pi sends and a stub context, and nothing the handler rewrites is run.
//
// Every test runs with PATH set to a stub directory (tests/support/stub-path.mjs), so a real gh
// or git on the machine is never reached from here.

import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodePayload } from "../bin/payload.mjs";
import { handlePreToolUse } from "../hooks/lib/claude.mjs";
import { gateToolCall, PI_ASK_VARIABLE } from "../hooks/lib/pi.mjs";
import agentAccessGate, { install } from "../pi/index.ts";
import {
  buildWorkspace,
  removeDir,
  tempDir,
  writeCatalog,
} from "./support/fixture-workspace.mjs";
import { COMMANDS, CWDS } from "./support/parity-cells.mjs";
import { findOnPath, makeStubDir } from "./support/stub-path.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(here, "..");
const LAUNCHER = resolve(repoDir, "bin", "with-gh-token.mjs");
const DEMO_CWD = "projects/repos/demo-repo";

let ws = "";
let stubDir = "";
const saved = {
  path: process.env.PATH,
  bash: process.env.CLAUDE_CODE_GIT_BASH_PATH,
  ask: process.env[PI_ASK_VARIABLE],
};

before(() => {
  // Everything the tests need from the machine is looked up before PATH is restricted.
  const bash = findOnPath("bash", saved.path ?? "");
  ws = tempDir("pi-ws-");
  buildWorkspace(ws, { level: "read" });
  stubDir = makeStubDir({ bash });
  process.env.PATH = stubDir;
  process.env.CLAUDE_CODE_GIT_BASH_PATH = process.execPath;
  delete process.env[PI_ASK_VARIABLE];
});

after(() => {
  restoreEnv("PATH", saved.path);
  restoreEnv("CLAUDE_CODE_GIT_BASH_PATH", saved.bash);
  restoreEnv(PI_ASK_VARIABLE, saved.ask);
  if (ws) removeDir(ws);
  if (stubDir) removeDir(stubDir);
});

/**
 * @param {string} name
 * @param {string | undefined} value
 */
function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const cwdOf = (rel: string) => join(ws, ...rel.split("/"));

type Confirm = (title: string, message: string) => Promise<boolean>;
type Ui = { confirm?: Confirm; asked: string[] };

// A UI that answers every ask with the same answer and records each question.
function ui(answer: boolean): Ui {
  const asked: string[] = [];
  return {
    asked,
    confirm: async (_title: string, message: string) => {
      asked.push(message);
      return answer;
    },
  };
}

type RunOptions = {
  cwd?: string;
  level?: string;
  ui?: Ui | null;
  toolName?: string;
  mode?: string;
};

// One tool_call through the adapter. cwd defaults to demo-repo, and an explicit undefined cwd
// means Pi reported none. ui null is a session with no UI. mode is Pi's ctx.mode, left out when
// not given.
async function run(command: string, options: RunOptions = {}) {
  writeCatalog(ws, options.level ?? "read");
  const event = {
    toolName: options.toolName ?? "bash",
    input: { command, timeout: 5 } as Record<string, unknown>,
  };
  const cwd = "cwd" in options ? options.cwd : cwdOf(DEMO_CWD);
  const session =
    options.ui === undefined || options.ui === null
      ? { cwd, hasUI: false, mode: options.mode }
      : {
          cwd,
          hasUI: true,
          mode: options.mode,
          ui: { confirm: options.ui.confirm },
        };
  const result = await gateToolCall(event, session, { workspaceRoot: ws });
  return { result, event, command: event.input.command as string };
}

function payloadOf(command: string) {
  return decodePayload(/'([A-Za-z0-9+/=]+)'$/.exec(command)?.[1] ?? "");
}

test("a denied write is blocked with the gate's reason, and the command is not changed", async () => {
  const { result, command } = await run("gh pr merge 1", { level: "read" });
  assert.equal(result?.block, true);
  assert.match(
    result?.reason,
    /agent-access: denied: demo-repo denies this command at level "read"/,
  );
  assert.equal(command, "gh pr merge 1");
});

test("a denied push to the organization main is blocked at a propose level", async () => {
  const { result } = await run("git push origin main", { level: "propose" });
  assert.equal(result?.block, true);
});

test("a read-only gh call runs through the launcher without a prompt, with the payload intact", async () => {
  const session = ui(true);
  const { result, event, command } = await run("gh pr view 1", {
    level: "read",
    ui: session,
  });
  assert.equal(result, undefined);
  assert.deepEqual(session.asked, [], "a read is never asked");
  assert.match(command, /with-gh-token\.mjs/);
  assert.equal(event.input.timeout, 5, "every other input field is kept");
  assert.deepEqual(payloadOf(command), {
    workspace: ws,
    repo: "demo-repo",
    command: "gh pr view 1",
  });
});

test("a gh write the person approves is rewritten through the launcher", async () => {
  const session = ui(true);
  const { result, command } = await run("gh pr merge 1", {
    level: "merge",
    ui: session,
  });
  assert.equal(result, undefined);
  assert.equal(session.asked.length, 1);
  assert.match(session.asked[0], /runs this gh command at level "merge"/);
  assert.match(command, /with-gh-token\.mjs/);
  assert.equal(payloadOf(command).command, "gh pr merge 1");
});

test("a gh write the person declines is blocked, and the command is not changed", async () => {
  const session = ui(false);
  const { result, command } = await run("gh pr merge 1", {
    level: "merge",
    ui: session,
  });
  assert.equal(session.asked.length, 1);
  assert.equal(result?.block, true);
  assert.match(result?.reason, /the person did not approve it/);
  assert.equal(command, "gh pr merge 1");
});

test("a gh write with no way to ask is blocked", async () => {
  const { result, command } = await run("gh pr merge 1", {
    level: "merge",
    ui: null,
  });
  assert.equal(result?.block, true);
  assert.match(result?.reason, /this session cannot ask for approval/);
  assert.equal(command, "gh pr merge 1");
});

test("the ask switch lets a gh write through a session with no way to ask", async () => {
  process.env[PI_ASK_VARIABLE] = "allow";
  try {
    const { result, command } = await run("gh pr merge 1", {
      level: "merge",
      ui: null,
    });
    assert.equal(result, undefined);
    assert.equal(payloadOf(command).command, "gh pr merge 1");
  } finally {
    delete process.env[PI_ASK_VARIABLE];
  }
});

test("the ask switch is read only when it is exactly allow", async () => {
  process.env[PI_ASK_VARIABLE] = "yes";
  try {
    const { result } = await run("gh pr merge 1", { level: "merge", ui: null });
    assert.equal(result?.block, true);
  } finally {
    delete process.env[PI_ASK_VARIABLE];
  }
});

test("the ask switch does not turn a denial into an allow", async () => {
  process.env[PI_ASK_VARIABLE] = "allow";
  try {
    const { result } = await run("gh pr merge 1", { level: "read", ui: null });
    assert.equal(result?.block, true);
    assert.match(result?.reason, /denies this command/);
  } finally {
    delete process.env[PI_ASK_VARIABLE];
  }
});

// rpc mode (how T3 drives Pi) has a prompt that nobody answers: it resolves false after 3 s. With
// the switch, an ask there must be rewritten at once, and no confirm may be sent.
test("rpc mode with the ask switch rewrites an ask without prompting", async () => {
  process.env[PI_ASK_VARIABLE] = "allow";
  try {
    const session = ui(false);
    const { result, command } = await run("gh pr merge 1", {
      level: "merge",
      mode: "rpc",
      ui: session,
    });
    assert.equal(result, undefined);
    assert.deepEqual(session.asked, [], "no confirm is sent in rpc mode");
    assert.equal(payloadOf(command).command, "gh pr merge 1");
  } finally {
    delete process.env[PI_ASK_VARIABLE];
  }
});

test("rpc mode without the ask switch asks, and a refusal blocks", async () => {
  const approve = ui(true);
  const approved = await run("gh pr merge 1", {
    level: "merge",
    mode: "rpc",
    ui: approve,
  });
  assert.equal(approve.asked.length, 1);
  assert.equal(approved.result, undefined);

  const refuse = ui(false);
  const refused = await run("gh pr merge 1", {
    level: "merge",
    mode: "rpc",
    ui: refuse,
  });
  assert.equal(refuse.asked.length, 1);
  assert.equal(refused.result?.block, true);
  assert.match(refused.result?.reason, /the person did not approve it/);
});

test("a TUI session still prompts the person when the ask switch is set", async () => {
  process.env[PI_ASK_VARIABLE] = "allow";
  try {
    const refuse = ui(false);
    const refused = await run("gh pr merge 1", {
      level: "merge",
      mode: "tui",
      ui: refuse,
    });
    assert.equal(refuse.asked.length, 1);
    assert.equal(refused.result?.block, true);
    assert.equal(refused.command, "gh pr merge 1");

    const approve = ui(true);
    const approved = await run("gh pr merge 1", {
      level: "merge",
      mode: "tui",
      ui: approve,
    });
    assert.equal(approve.asked.length, 1);
    assert.equal(approved.result, undefined);
  } finally {
    delete process.env[PI_ASK_VARIABLE];
  }
});

// Only rpc is rewritten under the switch. A missing or unknown mode with a prompt is asked, so an
// unanswered prompt resolves false and the call is blocked (fail closed).
test("a session with a prompt but no known mode is asked even with the switch, and a refusal blocks", async () => {
  process.env[PI_ASK_VARIABLE] = "allow";
  try {
    for (const mode of [undefined, "some-future-mode"]) {
      const refuse = ui(false);
      const refused = await run("gh pr merge 1", {
        level: "merge",
        mode,
        ui: refuse,
      });
      assert.equal(refuse.asked.length, 1, `mode ${mode}`);
      assert.equal(refused.result?.block, true, `mode ${mode}`);

      const approve = ui(true);
      const approved = await run("gh pr merge 1", {
        level: "merge",
        mode,
        ui: approve,
      });
      assert.equal(approve.asked.length, 1, `mode ${mode}`);
      assert.equal(approved.result, undefined, `mode ${mode}`);
    }
  } finally {
    delete process.env[PI_ASK_VARIABLE];
  }
});

test("a session with a UI but no confirm is not asked, and the switch rewrites its ask", async () => {
  process.env[PI_ASK_VARIABLE] = "allow";
  try {
    writeCatalog(ws, "merge");
    const event = { toolName: "bash", input: { command: "gh pr merge 1" } };
    const result = await gateToolCall(
      event,
      { cwd: cwdOf(DEMO_CWD), hasUI: true, mode: "tui", ui: {} },
      { workspaceRoot: ws },
    );
    assert.equal(result, undefined);
    assert.equal(
      payloadOf(event.input.command as string).command,
      "gh pr merge 1",
    );
  } finally {
    delete process.env[PI_ASK_VARIABLE];
  }
});

test("rpc mode with the ask switch still blocks a denial", async () => {
  process.env[PI_ASK_VARIABLE] = "allow";
  try {
    const session = ui(true);
    const { result } = await run("gh pr merge 1", {
      level: "read",
      mode: "rpc",
      ui: session,
    });
    assert.equal(result?.block, true);
    assert.match(result?.reason, /denies this command/);
    assert.deepEqual(session.asked, []);
  } finally {
    delete process.env[PI_ASK_VARIABLE];
  }
});

test("a direct run of the launcher is blocked", async () => {
  const { result } = await run(`node "${LAUNCHER}" abc`, { level: "full" });
  assert.equal(result?.block, true);
  assert.match(
    result?.reason,
    /the GitHub token launcher is not for direct use/,
  );
});

test("a call whose working directory is unknown is blocked for a write and passes for a read", async () => {
  const write = await run("gh pr merge 1", { cwd: undefined, level: "merge" });
  assert.equal(write.result?.block, true);
  assert.match(
    write.result?.reason,
    /could not determine the working directory/,
  );

  const read = await run("npm test", { cwd: undefined });
  assert.equal(read.result, undefined);
});

test("a directory outside the fleet is not gated", async () => {
  const { result, command } = await run("gh pr merge 1", {
    cwd: cwdOf("projects/other/x"),
    level: "read",
  });
  assert.equal(result, undefined);
  assert.equal(command, "gh pr merge 1");
});

test("the tool name is matched without regard to case, so Bash is gated too", async () => {
  const { result, command } = await run("gh pr merge 1", {
    toolName: "Bash",
    level: "read",
  });
  assert.equal(result?.block, true);
  assert.match(result?.reason, /denies this command at level "read"/);
  assert.equal(command, "gh pr merge 1");
});

test("a tool other than bash passes untouched", async () => {
  const session = ui(false);
  const { result, command } = await run("gh pr merge 1", {
    toolName: "read",
    level: "read",
    ui: session,
  });
  assert.equal(result, undefined);
  assert.equal(command, "gh pr merge 1");
  assert.deepEqual(session.asked, []);
});

test("a call the gate cannot read is blocked", async () => {
  for (const input of [undefined, {}, { command: 5 }]) {
    const event = { toolName: "bash", input };
    const result = await gateToolCall(
      event,
      { cwd: cwdOf(DEMO_CWD) },
      { workspaceRoot: ws },
    );
    assert.equal(result?.block, true, `input ${JSON.stringify(input)}`);
    assert.match(result?.reason, /could not evaluate this command/);
  }
});

test("an error from the approval prompt blocks the call", async () => {
  const session = {
    confirm: async () => {
      throw new Error("prompt closed");
    },
    asked: [],
  };
  const { result, command } = await run("gh pr merge 1", {
    level: "merge",
    ui: session,
  });
  assert.equal(result?.block, true);
  assert.match(result?.reason, /prompt closed/);
  assert.equal(command, "gh pr merge 1");
});

// The Claude answer for the same command, cwd, and level is the reference. The Pi answer must be
// the same answer in Pi's form: a deny is a block with the same reason, an allow or an approved ask
// is the same rewritten command, and no answer passes.
test("the Pi answer matches the Claude adapter's answer for every parity cell", async () => {
  const cwds = CWDS.filter((c) =>
    ["demo-root", "demo-sub", "fork", "nogit", "unlisted", "outside"].includes(
      c.id,
    ),
  );
  const cells = [];
  for (const level of ["read", "propose", "merge"]) {
    writeCatalog(ws, level);
    for (const cwd of cwds) {
      for (const command of COMMANDS) {
        const claude = await handlePreToolUse(
          { tool_name: "Bash", tool_input: { command }, cwd: cwdOf(cwd.path) },
          { workspaceRoot: ws },
        );
        const pi = await run(command, {
          cwd: cwdOf(cwd.path),
          level,
          ui: ui(true),
        });
        cells.push({
          cell: `${level} ${cwd.id} ${command}`,
          command,
          claude,
          pi,
        });
      }
    }
  }
  const seen = { pass: 0, deny: 0, rewrite: 0 };
  for (const { cell, command, claude, pi } of cells) {
    const hook = claude?.hookSpecificOutput;
    if (!hook) {
      seen.pass += 1;
      assert.equal(pi.result, undefined, cell);
      assert.equal(pi.command, command, cell);
    } else if (hook.permissionDecision === "deny") {
      seen.deny += 1;
      assert.equal(pi.result?.block, true, cell);
      assert.equal(pi.result?.reason, hook.permissionDecisionReason, cell);
    } else {
      seen.rewrite += 1;
      assert.equal(pi.result, undefined, cell);
      assert.equal(pi.command, hook.updatedInput.command, cell);
    }
  }
  // Each answer kind must occur, or the table would pass without checking it.
  assert.ok(
    seen.pass > 0 && seen.deny > 0 && seen.rewrite > 0,
    JSON.stringify(seen),
  );
});

// A fake ExtensionAPI that records the event each handler is registered for.
type ToolCall = { toolName: string; input?: unknown };
type Handler = (
  event: ToolCall,
  ctx: Record<string, unknown>,
) => Promise<{ block: true; reason: string } | undefined>;

function fakePi() {
  const events: string[] = [];
  const handlers = new Map<string, Handler>();
  const api = {
    on(event: string, handler: Handler) {
      events.push(event);
      handlers.set(event, handler);
      return () => {};
    },
  };
  return { api, events, handlers };
}

test("the entry registers one handler, for tool_call, and the default export registers the same", () => {
  const named = fakePi();
  install(named.api, { workspaceRoot: ws });
  assert.deepEqual(named.events, ["tool_call"]);

  const defaulted = fakePi();
  agentAccessGate(defaulted.api);
  assert.deepEqual(defaulted.events, ["tool_call"]);
});

test("the registered handler gates a call with the fixture workspace", async () => {
  writeCatalog(ws, "read");
  const pi = fakePi();
  install(pi.api, { workspaceRoot: ws });
  const handler = pi.handlers.get("tool_call");
  const result = await handler(
    { toolName: "bash", input: { command: "gh pr merge 1" } },
    { cwd: cwdOf(DEMO_CWD), hasUI: false },
  );
  assert.equal(result?.block, true);
  assert.match(result?.reason, /denies this command at level "read"/);
});

// A copy of the extension outside the trusted layouts: its own location trusts no workspace, so
// the gate denies a write it cannot check, and a command that is not a gh call passes.
test("a copy of the extension outside a trusted layout denies a write it cannot check", async () => {
  const copy = tempDir("pi-copy-");
  try {
    for (const entry of [
      "pi",
      "hooks",
      "bin",
      "lib",
      "gate.mjs",
      "access.mjs",
      "package.json",
    ])
      cpSync(join(repoDir, entry), join(copy, entry), { recursive: true });
    const { default: copied } = await import(
      pathToFileURL(join(copy, "pi", "index.ts")).href
    );
    const pi = fakePi();
    copied(pi.api);
    const handler = pi.handlers.get("tool_call");
    writeCatalog(ws, "merge");
    const write = await handler(
      { toolName: "bash", input: { command: "gh pr merge 1" } },
      { cwd: cwdOf(DEMO_CWD), hasUI: true, ui: ui(true) },
    );
    assert.equal(write?.block, true);
    assert.match(write?.reason, /not installed in a trusted workspace layout/);
    const other = await handler(
      { toolName: "bash", input: { command: "npm test" } },
      { cwd: cwdOf(DEMO_CWD) },
    );
    assert.equal(other, undefined);
  } finally {
    removeDir(copy);
  }
});

test("package.json names the Pi extension entry, and the entry exists", () => {
  const pkg = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));
  assert.deepEqual(pkg.pi, { extensions: ["./pi/index.ts"] });
  assert.ok(existsSync(join(repoDir, "pi", "index.ts")));
});
