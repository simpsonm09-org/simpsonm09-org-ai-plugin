// Binaries integration tests may run. The PATH stub supplies fake gh, Git for local committed
// catalog reads, and on POSIX bash. Tests that require Git to be missing use an empty directory.

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { FIXTURE_TOKEN } from "./fixture-workspace.mjs";

// The fake gh. It succeeds only when the fixture token is in its environment, and it never
// prints the token.
export const FAKE_GH = `#!/bin/sh\nif [ "$GH_TOKEN" = "${FIXTURE_TOKEN}" ]; then exit 0; fi\nexit 9\n`;

/**
 * The first file called name on a PATH value, or null.
 * @param {string} name
 * @param {string} [pathValue]
 * @returns {string | null}
 */
export function findOnPath(name, pathValue = process.env.PATH ?? "") {
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return null;
}

const REAL_GIT = findOnPath(process.platform === "win32" ? "git.exe" : "git");

/**
 * A directory that is the whole PATH for an integration test. It holds the fake gh, real git
 * for committed catalog reads, and on POSIX a link to real bash. Tests that need git absent
 * pass a separate empty directory.
 * @param {{ withGh?: boolean, bash?: string | null }} [options]
 * @returns {string}
 */
export function makeStubDir({ withGh = true, bash = findOnPath("bash") } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gh-stub-"));
  if (withGh) {
    // gh.exe is the same fake under the name Windows gives the program.
    for (const name of ["gh", "gh.exe"]) {
      const gh = join(dir, name);
      writeFileSync(gh, FAKE_GH, { mode: 0o755 });
      chmodSync(gh, 0o755);
    }
  }
  if (REAL_GIT) {
    const target = join(dir, process.platform === "win32" ? "git.exe" : "git");
    if (process.platform !== "win32") symlinkSync(REAL_GIT, target);
  }
  if (process.platform !== "win32" && bash && existsSync(bash))
    symlinkSync(bash, join(dir, "bash"));
  return dir;
}

/**
 * The restricted test PATH plus only Git for Windows' own runtime directories.
 * This keeps real gh binaries out while allowing the pinned resolver to read a local ref.
 * @param {string} dir
 */
export function stubPath(dir) {
  if (process.platform !== "win32") return dir;
  if (!REAL_GIT) return dir;
  const home = dirname(dirname(REAL_GIT));
  return [
    dir,
    join(home, "cmd"),
    join(home, "bin"),
    join(home, "mingw64", "bin"),
    join(home, "usr", "bin"),
  ].join(delimiter);
}
