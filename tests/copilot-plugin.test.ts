// The GitHub Copilot CLI manifest and hooks file. Copilot reads .github/plugin/plugin.json, which
// names hooks/copilot-hooks.json. The hooks file uses the camelCase event keys (preToolUse,
// sessionStart), which Copilot measured to send the native payload, and flat entries with `bash`
// and `powershell` command keys. A timeout ends the run through Copilot's normal permission flow,
// so the Copilot hook timeouts sit above the hook's own budgets: the budget answers first.

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

test("the hooks file is version 1 with camelCase event keys and flat entries", () => {
  const file = hooksFile();
  assert.equal(file.version, 1);
  assert.deepEqual(Object.keys(file.hooks).sort(), [
    "preToolUse",
    "sessionStart",
  ]);
  for (const event of ["preToolUse", "sessionStart"]) {
    assert.equal(file.hooks[event].length, 1, `${event} has one entry`);
    const entry = file.hooks[event][0];
    assert.equal(entry.type, "command");
    assert.equal(
      entry.hooks,
      undefined,
      `${event} entry is flat, with no nested hooks array`,
    );
    assert.ok(
      entry.bash && entry.powershell,
      `${event} has bash and powershell keys`,
    );
  }
});

test("the preToolUse entry matches the powershell and bash tools, and its timeout is above the budget", () => {
  const entry = hooksFile().hooks.preToolUse[0];
  assert.equal(entry.matcher, "powershell|bash");
  assert.ok(
    entry.timeoutSec > PRE_TOOL_USE_BUDGET.killMs / 1000,
    "the preToolUse timeout is above the outer kill, so the budget answers before Copilot does",
  );
});

test("the sessionStart entry has a timeout above its outer kill", () => {
  const entry = hooksFile().hooks.sessionStart[0];
  assert.ok(
    entry.timeoutSec > SESSION_START_BUDGET.killMs / 1000,
    "the sessionStart timeout is above its outer kill",
  );
});

test("every Copilot hook command runs a shipped script under COPILOT_PLUGIN_ROOT with the copilot runtime", () => {
  const file = hooksFile();
  for (const entry of [file.hooks.preToolUse[0], file.hooks.sessionStart[0]]) {
    for (const key of ["bash", "powershell"]) {
      const text: string = entry[key];
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
