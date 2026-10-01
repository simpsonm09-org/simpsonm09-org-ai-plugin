import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (name: string) =>
  JSON.parse(readFileSync(join(root, name), "utf8"));

test("layer.json names a config fragment that exists", () => {
  const layer = readJson("layer.json");

  assert.equal(layer.kind, "config");
  assert.equal(layer.config, "opencode.fragment.jsonc");
  assert.ok(existsSync(join(root, layer.config)), `${layer.config} is missing`);
});

test("the layer manifest and the package publish list agree and exist", () => {
  const layer = readJson("layer.json");
  const pkg = readJson("package.json");

  assert.deepEqual([...layer.files].sort(), [...pkg.files].sort());
  for (const entry of layer.files) {
    assert.ok(existsSync(join(root, entry)), `${entry} is missing`);
  }
});

test("the plugin entrypoint exists for the installer", () => {
  // Install-Workspace.ps1 requires index.ts for a layer with a pluginTarget.
  assert.ok(existsSync(join(root, "index.ts")));
});

test("the config fragment contributes no MCP server", () => {
  const fragment = readJson("opencode.fragment.jsonc");
  const servers = fragment.mcp?.servers;

  assert.ok(
    servers === undefined || Object.keys(servers).length === 0,
    "the org layer must not contribute an MCP server",
  );
});
