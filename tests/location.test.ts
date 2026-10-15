import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { realPath, workspaceForPluginRoot } from "../lib/location.mjs";
import { removeDir, tempDir } from "./support/fixture-workspace.mjs";

let fixture = "";
after(() => {
  if (fixture) removeDir(fixture);
});

test("plugin workspace recognition accepts direct Claude copies and existing trusted roots", () => {
  const workspace = "/home/agent/workspace";
  assert.equal(
    workspaceForPluginRoot(
      `${workspace}/.claude/plugins/simpsonm09-org-ai-plugin`,
    ),
    workspace,
  );
  assert.equal(
    workspaceForPluginRoot(
      `${workspace}/.opencode/plugins/simpsonm09-org-ai-plugin`,
    ),
    workspace,
  );
  assert.equal(
    workspaceForPluginRoot(
      `${workspace}/projects/repos/simpsonm09-org-ai-plugin`,
    ),
    workspace,
  );
  assert.equal(
    workspaceForPluginRoot(`${workspace}/projects/worktrees/plugin-worktree`),
    workspace,
  );
});

test("plugin workspace recognition accepts alternate Claude workspace roots", () => {
  assert.equal(
    workspaceForPluginRoot(
      "/outside/home/agent/workspace/.claude/plugins/plugin",
    ),
    "/outside/home/agent/workspace",
  );
  assert.equal(
    workspaceForPluginRoot(
      "/home/agent/workspace/nested/.claude/plugins/plugin",
    ),
    "/home/agent/workspace/nested",
  );
});

test("plugin workspace recognition rejects nested copies and cache lookalikes", () => {
  const workspace = "/home/agent/workspace";
  for (const root of [
    `${workspace}/.claude/plugins/plugin/nested`,
    `${workspace}/.claude/cache/plugins/plugin`,
    `${workspace}/.claude/plugins-cache/plugin`,
  ]) {
    assert.equal(workspaceForPluginRoot(root), null, root);
  }
});

test("a Claude junction resolves to the existing OpenCode trusted layout", () => {
  fixture = tempDir("plugin-location-");
  const openCodeRoot = join(fixture, ".opencode", "plugins", "plugin");
  const claudeRoot = join(fixture, ".claude", "plugins", "plugin");
  mkdirSync(openCodeRoot, { recursive: true });
  mkdirSync(join(fixture, ".claude", "plugins"), { recursive: true });
  symlinkSync(openCodeRoot, claudeRoot, "junction");
  assert.equal(workspaceForPluginRoot(realPath(claudeRoot)), fixture);
});
