// A real fleet clone has two remotes: `origin` is the personal fork and `upstream` is the
// organization repository. The historical golden file (tests/fixtures/parity-golden.json)
// models a single-remote clone, so the cells that the two-remote topology changes are declared
// in tests/fixtures/parity-two-remote.json rather than regenerated into the golden. This test
// runs each declared cell through both adapters and checks it against the recorded HEAD action
// for the same command without the ambiguity, so the fail-closed change is declared with its
// baseline rather than blessed.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(
  readFileSync(join(here, "fixtures", "parity-golden.json"), "utf8"),
) as {
  cells: Array<{ id: string; level: string; head: { action: string } }>;
};
const fixture = JSON.parse(
  readFileSync(join(here, "fixtures", "parity-two-remote.json"), "utf8"),
) as {
  rationale: Record<string, string>;
  cells: Array<{
    id: string;
    cwd: string;
    level: string;
    command: string;
    baselineCommand: string;
    head: string;
    now: string;
    declared: boolean;
    category: string;
  }>;
};

const TOKEN_ENV = { CLAUDE_CODE_GIT_BASH_PATH: process.execPath };
const CWD_PATH = "projects/repos/two-remote-repo";

type Row = {
  cell: (typeof fixture.cells)[number];
  openCode: {
    command: string;
    env: Record<string, string> | null;
    action: string;
  };
  claude: { action: string };
};

// HEAD decided a gh command by its first word and never read the clone's remotes, so its action
// for a two-remote cell is the golden action for the same command without the ambiguity, at the
// same level. A missing golden cell is a real failure, not a skip.
function goldenHead(baselineCommand: string, level: string): string {
  const cell = golden.cells.find(
    (entry) => entry.id === `demo-root|posix|${level}|${baselineCommand}`,
  );
  assert.ok(cell, `no golden cell for ${baselineCommand} @ ${level}`);
  return cell.head.action;
}

function claudeExpected(action: string): string {
  if (action === "pass") return "pass";
  if (action === "deny") return "deny";
  return "inject";
}

let workspace = "";
let rows: Row[] = [];

before(async () => {
  workspace = tempDir("gate-two-remote-");
  buildWorkspace(workspace, { level: "read" });
  const openCode = await openCodeHook(plugin, { workspaceRoot: workspace });
  const ordered = [...fixture.cells].sort((a, b) =>
    a.level.localeCompare(b.level),
  );
  const out: Row[] = [];
  let level = "";
  for (const cell of ordered) {
    if (cell.level !== level) {
      level = cell.level;
      writeCatalog(workspace, level);
    }
    const cwd = cwdFor(workspace, CWD_PATH);
    const openCodeRow = await runOpenCode(
      openCode,
      { command: cell.command, cwd },
      cell.command,
    );
    const claude = await runClaude(
      handlePreToolUse,
      { tool: "Bash", cwd, command: cell.command },
      { workspaceRoot: workspace, env: TOKEN_ENV },
    );
    out.push({ cell, openCode: openCodeRow, claude });
  }
  rows = out;
});

after(() => {
  if (workspace) removeDir(workspace);
});

test("every declared cell carries the recorded HEAD action for the same command", () => {
  for (const cell of fixture.cells) {
    assert.equal(
      cell.head,
      goldenHead(cell.baselineCommand, cell.level),
      `${cell.id}: HEAD action`,
    );
    assert.equal(
      cell.declared,
      cell.head !== cell.now,
      `${cell.id}: only a real decision change is declared`,
    );
  }
});

test("the fixture declares a rationale for each category it uses", () => {
  const categories = new Set(fixture.cells.map((cell) => cell.category));
  for (const category of categories)
    assert.ok(fixture.rationale[category], `no rationale for ${category}`);
  assert.equal(
    new Set(Object.keys(fixture.rationale)).size,
    categories.size,
    "a rationale exists for a category no cell uses",
  );
});

test("each two-remote cell reaches its declared new decision", (t) => {
  const mismatches: string[] = [];
  for (const row of rows) {
    if (row.openCode.action !== row.cell.now)
      mismatches.push(
        `${row.cell.id} expected=${row.cell.now} got=${row.openCode.action}`,
      );
  }
  t.diagnostic(
    `two-remote cells: ${rows.length}, declared changes: ${fixture.cells.filter((cell) => cell.declared).length}`,
  );
  assert.deepEqual(mismatches, []);
});

test("the Claude hook agrees with the OpenCode adapter for every two-remote cell", () => {
  const mismatches: string[] = [];
  for (const row of rows) {
    const expected = claudeExpected(row.cell.now);
    if (row.claude.action !== expected)
      mismatches.push(
        `${row.cell.id} expected=${expected} claude=${row.claude.action}`,
      );
  }
  assert.deepEqual(mismatches, []);
});

test("an ambiguous gh write is denied with the -R hint and never says unknown", () => {
  const ambiguous = rows.filter(
    (row) =>
      row.cell.category === "ambiguous-gh-write" &&
      row.cell.now === "deny" &&
      !row.cell.command.startsWith("gh api "),
  );
  assert.ok(ambiguous.length > 0, "the matrix declares ambiguous gh writes");
  for (const row of ambiguous) {
    assert.equal(row.openCode.action, "deny", row.cell.id);
    assert.match(
      row.openCode.command,
      /specify -R owner\/repo for a new operation/,
      row.cell.id,
    );
    assert.doesNotMatch(row.openCode.command, /unknown/, row.cell.id);
  }
});

test("an API endpoint overrides the clone remotes and is judged as its own repository", () => {
  const endpoint = rows.find(
    (row) => row.cell.category === "gh-api-endpoint-destination",
  );
  assert.ok(endpoint);
  assert.equal(endpoint.openCode.action, "deny");
  assert.match(endpoint.openCode.command, /destination o\/r denies/);
  assert.doesNotMatch(endpoint.openCode.command, /specify -R owner\/repo/);
});

test("a pass keeps the command and sets no token; an inject sets the fixture token", () => {
  for (const row of rows) {
    if (row.cell.now === "pass") {
      assert.equal(row.openCode.command, row.cell.command, row.cell.id);
      assert.equal(row.openCode.env?.GH_TOKEN, undefined, row.cell.id);
    } else if (row.cell.now === "inject") {
      assert.equal(row.openCode.command, row.cell.command, row.cell.id);
      assert.equal(row.openCode.env?.GH_TOKEN, FIXTURE_TOKEN, row.cell.id);
    } else {
      assert.notEqual(row.openCode.command, row.cell.command, row.cell.id);
    }
  }
});
