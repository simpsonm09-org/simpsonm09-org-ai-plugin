// The differential against the baseline gate. tests/fixtures/parity-golden.json holds the
// recorded HEAD decision for each cell (command text, environment, action) from a scratch
// runner outside this repository; it is not regenerated to match new behavior.
// tests/fixtures/parity-decisions.json records the cells the destination-aware gate changes on
// purpose, with the HEAD action, the new action, and the reason, so every change is declared
// rather than blessed. This test runs the same cells through the current code and the packaged,
// hash-verified resolver, with no sibling clone.
//
// Requirements it checks:
//   - every cell reaches its recorded decision: the HEAD action, or the declared new action;
//   - a pass keeps the command text and sets no token; an inject sets the fixture token and
//     keeps the command text; a deny rewrites the command (the reason text is informational);
//   - the Claude hook gives the same decision as the OpenCode adapter for every cell;
//   - the declared intended changes (INTENDED_CWDS) are gated exactly like their clone: a
//     worktree of a clone, a case variant of a clone's path, and a junction from outside
//     projects/repos into a clone. A case variant is only checked on a case-insensitive file
//     system, where the uppercase path names the clone.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { handlePreToolUse } from "../hooks/lib/claude.mjs";
import plugin from "../index.ts";
import {
  buildWorkspace,
  FIXTURE_TOKEN,
  removeDir,
  tempDir,
  writeCatalog,
} from "./support/fixture-workspace.mjs";
import {
  cwdFor,
  openCodeHook,
  runClaude,
  runOpenCode,
} from "./support/harness.mjs";
import {
  CASE_SENSITIVE_CWDS,
  committedCells,
  INTENDED_CWDS,
} from "./support/parity-cells.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(
  readFileSync(join(here, "fixtures", "parity-golden.json"), "utf8"),
) as {
  recordedFrom: string;
  cells: Array<{
    id: string;
    cwd: string;
    cwdPath: string;
    command: string;
    level: string;
    shell?: string;
    head: {
      command: string;
      env: Record<string, string> | null;
      action: "pass" | "deny" | "inject";
    };
  }>;
};
const decisions = JSON.parse(
  readFileSync(join(here, "fixtures", "parity-decisions.json"), "utf8"),
) as {
  recordedFrom: string;
  rationale: Record<string, string>;
  changes: Array<{
    id: string;
    cwd: string;
    level: string;
    command: string;
    head: string;
    now: string;
    category: string;
  }>;
};

const TOKEN_ENV = { CLAUDE_CODE_GIT_BASH_PATH: process.execPath };
const declaredIds = new Set(decisions.changes.map((change) => change.id));
const declared = new Map(
  decisions.changes.map((change) => [change.id, change]),
);

type Row = {
  id: string;
  cwd: string;
  command: string;
  level: string;
  shell?: string;
  openCode: {
    command: string;
    env: Record<string, string> | null;
    action: string;
  };
  claude: { action: string; permission?: string; output: unknown };
};

let workspace = "";
let rows: Row[] = [];
let caseInsensitive = false;

// The Claude action a decision maps to. A PowerShell gh call is refused, not rewritten.
function claudeExpected(action: string, shell?: string): string {
  if (action === "pass") return "pass";
  if (action === "deny") return "deny";
  return shell ? "deny" : "inject";
}

// The decision one cell must reach: the declared new action, or HEAD's.
function expectedAction(cell: { id: string }, head: string): string {
  return declared.get(cell.id)?.now ?? head;
}

// Whether a row is checked in this run: a case variant only on a case-insensitive file system.
function checked(cwd: string): boolean {
  return !(CASE_SENSITIVE_CWDS.includes(cwd) && !caseInsensitive);
}

// Run every committed cell through both current adapters, grouped by level so each catalog is
// written once.
async function runAll(): Promise<Row[]> {
  const openCode = await openCodeHook(plugin, { workspaceRoot: workspace });
  const ordered = [...committedCells()].sort((a, b) =>
    a.level.localeCompare(b.level),
  );
  const out: Row[] = [];
  let level = "";
  for (const cell of ordered) {
    if (!checked(cell.cwd)) continue;
    if (cell.level !== level) {
      level = cell.level;
      writeCatalog(workspace, level);
    }
    const cwd = cwdFor(workspace, cell.cwdPath);
    const oc = await runOpenCode(
      openCode,
      {
        command: cell.command,
        cwd,
        ...(cell.shell ? { shell: cell.shell } : {}),
      },
      cell.command,
    );
    const claude = await runClaude(
      handlePreToolUse,
      { tool: cell.shell ? "PowerShell" : "Bash", cwd, command: cell.command },
      { workspaceRoot: workspace, env: TOKEN_ENV },
    );
    out.push({
      id: cell.id,
      cwd: cell.cwd,
      command: cell.command,
      level: cell.level,
      ...(cell.shell ? { shell: cell.shell } : {}),
      openCode: oc,
      claude: {
        action: claude.action,
        permission: claude.permission,
        output: claude.output,
      },
    });
  }
  return out;
}

before(async () => {
  workspace = tempDir("gate-parity-");
  buildWorkspace(workspace, { level: "read" });
  caseInsensitive = existsSync(join(workspace, "projects", "REPOS"));
  rows = await runAll();
});

after(() => {
  if (workspace) removeDir(workspace);
});

function goldenFor(id: string) {
  const want = golden.cells.find((cell) => cell.id === id);
  assert.ok(want, `no golden for ${id}`);
  return want;
}

test("the golden file holds exactly the committed cell list", () => {
  const expected = committedCells()
    .map((cell) => cell.id)
    .sort();
  const recorded = golden.cells.map((cell) => cell.id).sort();
  assert.deepEqual(
    recorded,
    expected,
    "regenerate tests/fixtures/parity-golden.json with the scratch runner",
  );
});

test("the decision-change fixture declares only real cells, with a rationale per category", () => {
  const ids = new Set(committedCells().map((cell) => cell.id));
  for (const change of decisions.changes) {
    assert.ok(
      ids.has(change.id),
      `declared change is not a committed cell: ${change.id}`,
    );
    assert.ok(
      !INTENDED_CWDS.includes(change.cwd),
      `declared change is an intended cwd: ${change.id}`,
    );
    assert.ok(
      decisions.rationale[change.category],
      `no rationale for category ${change.category}`,
    );
    assert.notEqual(change.head, change.now, change.id);
  }
  assert.equal(
    new Set(decisions.changes.map((c) => c.category)).size,
    Object.keys(decisions.rationale).length,
  );
});

test("the OpenCode adapter reaches the recorded decision for every cell", (t) => {
  const mismatches: string[] = [];
  let compared = 0;
  let changed = 0;
  for (const row of rows) {
    if (INTENDED_CWDS.includes(row.cwd)) continue;
    const want = goldenFor(row.id);
    const expected = expectedAction(row, want.head.action);
    compared += 1;
    if (expected !== want.head.action) changed += 1;
    if (row.openCode.action !== expected)
      mismatches.push(
        `${row.id} expected=${expected} got=${row.openCode.action}`,
      );
  }
  t.diagnostic(
    `cells compared: ${compared}, declared decision changes: ${changed}`,
  );
  assert.deepEqual(
    mismatches,
    [],
    `OpenCode differs from the recorded decision for: ${mismatches.join("; ")}`,
  );
  assert.equal(
    changed,
    decisions.changes.length,
    "every declared change must fire, and no other cell may change",
  );
});

test("a pass keeps the command and no token; an inject keeps the command and the fixture token", () => {
  for (const row of rows) {
    if (INTENDED_CWDS.includes(row.cwd)) continue;
    const want = goldenFor(row.id);
    const expected = expectedAction(row, want.head.action);
    const isDeclared = declaredIds.has(row.id);
    if (expected === "pass") {
      assert.equal(row.openCode.command, row.command, row.id);
      if (isDeclared)
        assert.equal(row.openCode.env?.GH_TOKEN, undefined, row.id);
      else assert.deepEqual(row.openCode.env, want.head.env, row.id);
    } else if (expected === "inject") {
      assert.equal(row.openCode.command, row.command, row.id);
      assert.equal(row.openCode.env?.GH_TOKEN, FIXTURE_TOKEN, row.id);
      if (!isDeclared)
        assert.deepEqual(row.openCode.env, want.head.env, row.id);
    } else {
      assert.notEqual(row.openCode.command, row.command, row.id);
    }
  }
});

test("the Claude hook gives the same decision as the OpenCode adapter for every cell", (t) => {
  const mismatches: string[] = [];
  let compared = 0;
  for (const row of rows) {
    if (INTENDED_CWDS.includes(row.cwd)) continue;
    const want = goldenFor(row.id);
    const expected = expectedAction(row, want.head.action);
    compared += 1;
    const claude = claudeExpected(expected, row.shell);
    if (row.claude.action !== claude)
      mismatches.push(
        `${row.id} expected=${claude} claude=${row.claude.action}`,
      );
  }
  t.diagnostic(`cells compared: ${compared}`);
  assert.deepEqual(
    mismatches,
    [],
    `Claude differs from the recorded decision for: ${mismatches.join("; ")}`,
  );
});

test("a rewritten gh call keeps every original tool input field", () => {
  const injected = rows.filter((row) => row.claude.action === "inject");
  assert.ok(injected.length > 0, "the matrix has rewritten gh calls");
  for (const row of injected) {
    const updated = row.claude.output.hookSpecificOutput.updatedInput;
    assert.equal(updated.description, "parity", row.id);
    assert.match(updated.command, /with-gh-token\.mjs/, row.id);
  }
});

test("each declared intended change is gated exactly like its clone (demo-root)", (t) => {
  const mismatches: string[] = [];
  let compared = 0;
  let gated = 0;
  for (const row of rows) {
    if (!INTENDED_CWDS.includes(row.cwd)) continue;
    const clone = rows.find(
      (other) =>
        other.cwd === "demo-root" &&
        other.command === row.command &&
        other.level === row.level &&
        (other.shell ?? "") === (row.shell ?? ""),
    );
    if (!clone) continue;
    compared += 1;
    if (row.openCode.action !== "pass") gated += 1;
    const same =
      row.openCode.command === clone.openCode.command &&
      JSON.stringify(row.openCode.env) === JSON.stringify(clone.openCode.env) &&
      row.claude.action === clone.claude.action &&
      row.claude.permission === clone.claude.permission;
    if (!same) mismatches.push(row.id);
  }
  t.diagnostic(
    `intended-change cells compared: ${compared}, gated (OpenCode): ${gated}, case-insensitive file system: ${caseInsensitive}`,
  );
  assert.ok(
    gated > 0,
    "some intended-change cells are gated, which HEAD never did",
  );
  assert.deepEqual(
    mismatches,
    [],
    `an intended change differs from its clone for: ${mismatches.join("; ")}`,
  );
});

test("the matrix reaches every decision HEAD makes", () => {
  const actions = new Set(golden.cells.map((cell) => cell.head.action));
  assert.deepEqual([...actions].sort(), ["deny", "inject", "pass"]);
});

test("the declared changes are recorded against the same HEAD as the golden", () => {
  assert.equal(decisions.recordedFrom, golden.recordedFrom);
  assert.ok(declaredIds.size > 0);
});
