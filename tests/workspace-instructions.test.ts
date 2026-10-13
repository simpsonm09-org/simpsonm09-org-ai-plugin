import assert from "node:assert/strict";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const file = "workspace-instructions.md";

test("workspace instructions are a safe, small installed layer file", () => {
  const layer = JSON.parse(readFileSync(resolve(root, "layer.json"), "utf8"));
  assert.equal(layer.workspaceInstructions, file);
  assert.ok(layer.files.includes(file));
  const target = resolve(root, layer.workspaceInstructions);
  const rel = relative(root, target);
  assert.ok(!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
  const realRel = relative(realpathSync(root), realpathSync(target));
  assert.ok(
    !isAbsolute(realRel) && realRel !== ".." && !realRel.startsWith(`..${sep}`),
  );
  assert.ok(statSync(target).isFile());
  const bytes = readFileSync(target);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assert.ok(bytes.length <= 4096);
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  assert.ok(lines.length > 1 && lines.length <= 25);
  assert.ok(lines[0].startsWith("# "));
  assert.ok(lines.slice(1).every((line) => line.startsWith("- ")));
  assert.doesNotMatch(text, /\b[A-Za-z]:[\\/]|\/home\/|\/Users\//);
  assert.doesNotMatch(
    text,
    /(?:\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b|\bBearer\s+[A-Za-z0-9._~+/=-]{12,})/i,
  );
  assert.ok(!text.includes("—"));
});
