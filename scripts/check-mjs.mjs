#!/usr/bin/env node
// Flint's biome patterns stop at `*.ts`/`*.js`/`*.json`, so every committed `.mjs` file is
// outside the shared lint gate even though it is shipped code. This check runs biome (lint,
// format, and the organize-imports assist, exactly as Flint's `biome` linter runs it) over each
// one, so a cognitive-complexity, lint, or formatting defect in a runtime `.mjs` fails CI the same
// way it would in a `.ts` file. It reads the file list from git, so a new untracked module is
// checked before it is committed.
//
// The vendored resolver bundle is generated from the reviewed source object in the standard clone
// and is verified against its pin (lib/pinned-access.mjs). It is excluded here and marked
// `linguist-generated` in .gitattributes: it must stay byte-identical, so it is never reformatted.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENDORED = "runtime/agent-access.mjs";
const EXTENSIONS = ["*.mjs"];

// Every `.mjs` git knows about: tracked files in CI, plus a new untracked module locally, minus
// the vendored bundle.
/**
 * @returns {string[]}
 */
function mjsFiles() {
  const listed = spawnSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...EXTENSIONS,
    ],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
  if (listed.error || listed.status !== 0) {
    process.stderr.write(
      `check-mjs: git ls-files failed: ${listed.error?.message ?? listed.stderr}\n`,
    );
    process.exit(1);
  }
  return listed.stdout
    .split("\n")
    .map((line) => line.trim().replace(/\\/g, "/"))
    .filter((line) => line.length > 0 && line !== VENDORED);
}

const files = mjsFiles();
if (files.length === 0) {
  process.stderr.write(
    "check-mjs: no .mjs files were found; refusing to report a vacuous pass\n",
  );
  process.exit(1);
}

const result = spawnSync("biome", ["check", ...files], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) {
  process.stderr.write(
    `check-mjs: could not run biome: ${result.error.message}\n`,
  );
  process.exit(1);
}
process.exit(result.status ?? 1);
