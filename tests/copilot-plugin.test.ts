// The GitHub Copilot CLI manifest and hooks file. Copilot reads .github/plugin/plugin.json, which
// names hooks/copilot-hooks.json. Copilot denies a call when a PreToolUse command exits non-zero
// and treats a timeout as falling through to its normal permission flow, so the Copilot hook
// timeouts must sit above the hook's own budgets: the budget answers before Copilot gives up.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PRE_TOOL_USE_BUDGET, SESSION_START_BUDGET } from "../lib/budget.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (name: string) =>
  JSON.parse(readFileSync(join(root, name), "utf8"));

const copilot = () => readJson(".github/plugin/plugin.json");
const hooksFile = () => readJson("hooks/copilot-hooks.json");

test("the Copilot manifest has the Claude manifest's name and version", () => {
  const manifest = copilot();
  const claude = readJson(".claude-plugin/plugin.json");
  assert.equal(manifest.name, claude.name);
  assert.equal(manifest.version, claude.version);
  assert.equal(manifest.version, readJson("package.json").version);
  assert.ok(
    manifest.description?.length > 0,
    "the manifest needs a description",
  );
});

test("the Copilot manifest names a hooks file that exists", () => {
  const manifest = copilot();
  assert.equal(manifest.hooks, "hooks/copilot-hooks.json");
  assert.ok(
    existsSync(join(root, manifest.hooks)),
    `${manifest.hooks} is missing`,
  );
  assert.deepEqual(readdirSync(join(root, ".github", "plugin")), [
    "plugin.json",
  ]);
});

test("the Copilot PreToolUse hook covers the bash and powershell tools, and its timeout is above the budget", () => {
  const { hooks } = hooksFile();
  const pre = hooks.PreToolUse;
  assert.equal(pre.length, 1);
  const names = pre[0].matcher.split("|");
  for (const tool of ["bash", "powershell"]) {
    assert.ok(names.includes(tool), `the matcher lacks ${tool}`);
  }
  const entry = pre[0].hooks[0];
  assert.equal(entry.type, "command");
  assert.ok(
    entry.timeoutSec > PRE_TOOL_USE_BUDGET.killMs / 1000,
    "the PreToolUse timeout is above the outer kill, so the budget answers before Copilot does",
  );
});

test("the Copilot SessionStart hook has a timeout above its outer kill", () => {
  const { hooks } = hooksFile();
  assert.equal(hooks.SessionStart.length, 1);
  assert.ok(
    hooks.SessionStart[0].hooks[0].timeoutSec >
      SESSION_START_BUDGET.killMs / 1000,
    "the SessionStart timeout is above its outer kill",
  );
});

test("every Copilot hook command runs a shipped script under COPILOT_PLUGIN_ROOT with the copilot runtime", () => {
  const { hooks } = hooksFile();
  for (const entry of [hooks.PreToolUse[0], hooks.SessionStart[0]]) {
    const command = entry.hooks[0];
    for (const [key, text] of [
      ["command", command.command],
      ["powershell", command.powershell],
    ]) {
      const match =
        /"\$(?:\{COPILOT_PLUGIN_ROOT\}|env:COPILOT_PLUGIN_ROOT)\/([^"]+)" copilot$/.exec(
          text,
        );
      assert.ok(
        match,
        `${key} "${text}" runs a script under COPILOT_PLUGIN_ROOT with the copilot argument`,
      );
      assert.ok(existsSync(join(root, match[1])), `${match[1]} is missing`);
    }
  }
});

test("the Copilot hooks file is published with the layer and the package", () => {
  for (const file of ["layer.json", "package.json"]) {
    assert.ok(
      readJson(file).files.includes(".github/plugin"),
      `${file} lacks .github/plugin`,
    );
  }
  assert.ok(
    readFileSync(join(root, "hooks", "copilot-hooks.json"), "utf8").length > 0,
  );
});
