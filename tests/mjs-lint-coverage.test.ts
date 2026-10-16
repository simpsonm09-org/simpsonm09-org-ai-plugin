// Flint's biome patterns stop at *.ts/*.js/*.json, so every committed runtime *.mjs file is
// outside the shared lint gate. The repository closes that gap with a `complexity` recipe that
// lints and format-checks them; the shared lint workflow runs that recipe only when it exists.
// These assertions keep the wiring in place, because a deleted recipe or check would silently
// drop every runtime module from CI while the suite stayed green.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name: string) => readFileSync(join(root, name), "utf8");

test("the justfile keeps the complexity recipe the shared lint workflow runs", () => {
  const justfile = read("justfile");
  const body =
    /^complexity:[^\S\n]*\n((?:[ \t]+\S[^\n]*\n)+)/m.exec(justfile)?.[1] ?? "";

  assert.ok(body.length > 0, 'justfile has no "complexity" recipe');
  assert.match(body, /node scripts\/check-mjs\.mjs/);
});

test("the .mjs check covers every committed module and skips only the vendored bundle", () => {
  const check = read("scripts/check-mjs.mjs");
  assert.match(check, /biome/);
  assert.match(
    check,
    /"runtime\/agent-access\.mjs"/,
    "the check must name the vendored bundle it excludes",
  );
  assert.match(
    read("biome.jsonc"),
    /"!runtime\/agent-access\.mjs"/,
    "biome must exclude the vendored resolver bundle",
  );
});
