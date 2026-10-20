import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { handleCursor } from "../hooks/lib/cursor.mjs";
import {
  buildWorkspace,
  removeDir,
  tempDir,
  writeCatalog,
} from "./support/fixture-workspace.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "hooks", "cursor.mjs");
let workspace = "";
const cwd = () => join(workspace, "projects", "repos", "demo-repo");

before(() => {
  workspace = tempDir("cursor-adapter-");
  buildWorkspace(workspace);
});
after(() => {
  if (workspace) removeDir(workspace);
});

function run(payload: unknown) {
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

function decide(payload: unknown) {
  return handleCursor(payload, { workspaceRoot: workspace });
}

test("Cursor allows reads and denies writes with the shared gate reason", async () => {
  writeCatalog(workspace, "read");
  assert.equal(
    (await decide({ command: "git status --short", cwd: cwd() })).permission,
    "allow",
  );
  const denied = await decide({ command: "gh pr merge 1", cwd: cwd() });
  assert.equal(denied.permission, "deny");
  assert.match(denied.user_message, /agent-access: denied: .*denies/i);
});

test("Cursor fails closed on malformed JSON and leaves other hook events alone", () => {
  assert.equal(run("{")?.permission, "deny");
  assert.equal(
    run({
      hook_event_name: "beforeMCPExecution",
      command: "gh pr merge 1",
      cwd: cwd(),
    }),
    null,
  );
});

test("Cursor reads Bash and PowerShell command forms", async () => {
  writeCatalog(workspace, "read");
  for (const [command, shell] of [
    ["git status --short", "bash"],
    ["& git status --short", "powershell"],
  ]) {
    assert.equal(
      (await decide({ command, shell, cwd: cwd() })).permission,
      "allow",
    );
  }
  assert.equal(
    (
      await decide({
        command: "& git push origin main",
        shell: "powershell",
        cwd: cwd(),
      })
    ).permission,
    "deny",
  );
});
