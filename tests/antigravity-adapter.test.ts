import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { handleAntigravity } from "../hooks/lib/antigravity.mjs";
import {
  buildWorkspace,
  removeDir,
  tempDir,
  writeCatalog,
} from "./support/fixture-workspace.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "hooks", "antigravity.mjs");
let workspace = "";
const cwd = () => join(workspace, "projects", "repos", "demo-repo");

before(() => {
  workspace = tempDir("antigravity-adapter-");
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

const call = (command: string, Shell?: string) => ({
  hook_event_name: "PreToolUse",
  toolCall: {
    name: "run_command",
    args: { CommandLine: command, Cwd: cwd(), ...(Shell ? { Shell } : {}) },
  },
});

const decide = (payload: unknown) =>
  handleAntigravity(payload, { workspaceRoot: workspace });

test("Antigravity allows reads and denies writes with the shared gate reason", async () => {
  writeCatalog(workspace, "read");
  assert.equal((await decide(call("git status --short"))).decision, "allow");
  const denied = await decide(call("gh pr merge 1"));
  assert.equal(denied.decision, "deny");
  assert.match(denied.reason, /agent-access: denied: .*denies/i);
});

test("Antigravity fails closed on malformed JSON and leaves other tools alone", () => {
  assert.equal(run("{").decision, "deny");
  assert.equal(
    run({
      hook_event_name: "PreToolUse",
      toolCall: { name: "read_file", args: {} },
    }),
    null,
  );
});

test("Antigravity reads Bash and PowerShell command forms", async () => {
  writeCatalog(workspace, "read");
  assert.equal(
    (await decide(call("git status --short", "bash"))).decision,
    "allow",
  );
  assert.equal(
    (await decide(call("& git status --short", "powershell"))).decision,
    "allow",
  );
  assert.equal(
    (await decide(call("& git push origin main", "powershell"))).decision,
    "deny",
  );
});
