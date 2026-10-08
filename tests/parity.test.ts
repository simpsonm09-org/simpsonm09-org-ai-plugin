// The differential against HEAD's gate. tests/fixtures/parity-golden.json holds what HEAD's
// index.ts and gate.mjs decided for each cell (command text, environment, action), recorded
// with the installed resolver, a fixture token, and real local git clones (see the scratch
// runner's --write-golden). This test runs the same cells through the current code, with no
// sibling clone: the resolver is the frozen copy in tests/fixtures.
//
// Requirements it checks:
//   - the OpenCode adapter gives the same command text and environment as HEAD for every cell
//     that is not a declared intended change (byte-identical), and the Claude hook gives HEAD's
//     decision for the same cells;
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

const TOKEN_ENV = { CLAUDE_CODE_GIT_BASH_PATH: process.execPath };

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

// The Claude action a HEAD action maps to. A PowerShell gh call is refused, not rewritten.
function claudeExpected(head: string, shell?: string): string {
  if (head === "pass") return "pass";
  if (head === "deny") return "deny";
  return shell ? "deny" : "inject";
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

test("the OpenCode adapter matches HEAD byte for byte for every cell that is not an intended change", (t) => {
  const mismatches: string[] = [];
  let compared = 0;
  for (const row of rows) {
    if (INTENDED_CWDS.includes(row.cwd)) continue;
    const want = goldenFor(row.id);
    compared += 1;
    const same =
      row.openCode.command === want.head.command &&
      JSON.stringify(row.openCode.env) === JSON.stringify(want.head.env);
    if (!same) mismatches.push(row.id);
  }
  t.diagnostic(`cells compared: ${compared}`);
  assert.deepEqual(
    mismatches,
    [],
    `OpenCode differs from HEAD for: ${mismatches.join("; ")}`,
  );
});

test("the Claude hook gives HEAD's decision for every cell that is not an intended change", (t) => {
  const mismatches: string[] = [];
  let compared = 0;
  for (const row of rows) {
    if (INTENDED_CWDS.includes(row.cwd)) continue;
    const want = goldenFor(row.id);
    compared += 1;
    if (row.claude.action !== claudeExpected(want.head.action, row.shell))
      mismatches.push(
        `${row.id} head=${want.head.action} claude=${row.claude.action}`,
      );
  }
  t.diagnostic(`cells compared: ${compared}`);
  assert.deepEqual(
    mismatches,
    [],
    `Claude differs from HEAD for: ${mismatches.join("; ")}`,
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
