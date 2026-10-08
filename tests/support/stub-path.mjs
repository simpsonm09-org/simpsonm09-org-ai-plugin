// Binaries a test may run, and nothing else. A launcher test runs with PATH set to a stub
// directory that holds a fake gh (with the execute bit) and, on POSIX, a link to bash. Any
// real gh or git on the machine is therefore not reachable from the test: a missing stub
// fails with "command not found" instead of finding the real program.

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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

/**
 * A directory that is the whole PATH for a launcher test. It holds the fake gh, and on POSIX
 * a link to the real bash (found before the PATH is restricted), so the child can run.
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
  if (process.platform !== "win32" && bash && existsSync(bash))
    symlinkSync(bash, join(dir, "bash"));
  return dir;
}
