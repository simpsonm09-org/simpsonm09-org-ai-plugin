// A gh command that names its repository with -R/--repo. The verdict is the destination's,
// which the resolver already decided that way, but the denial text has to name the repository
// the command reaches rather than the clone it happened to run in. These tests run the real
// path: a fixture workspace, the real fleet lookup, the committed catalog, and the
// hash-verified pinned resolver behind the gate. They assert what a caller observes (allowed,
// denied, which repository the reason names, whether a token is injected), not which name the
// gate hands the resolver. No network, no credential, no remote: the remotes are names in the
// fixture's git config.

import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  defaultScripts,
  gitReader,
  loadAccessApi,
  resolveAccess,
} from "../access.mjs";
import { decideShell } from "../gate.mjs";
import { fleetLookup } from "../lib/fleet.mjs";
import type { Observation } from "../lib/observation.mjs";
import {
  buildWorkspace,
  removeDir,
  tempDir,
  writeCatalogLevels,
} from "./support/fixture-workspace.mjs";

let workspace = "";
let catalog = "";
/** @type {Awaited<ReturnType<typeof loadAccessApi>>} */
let api = null;

// One command decided the way both adapters decide it: the fleet lookup names the clone the
// command runs in, the git reader supplies its real git state, and the pinned resolver answers
// from the fixture's committed catalog.
/**
 * @param {string} command
 * @param {string} relativeCwd
 */
function decide(command: string, relativeCwd: string) {
  return decideShell(
    { command },
    {
      cwd: join(workspace, ...relativeCwd.split("/")),
      workspaceRoot: workspace,
      lookup: (dir: string) => fleetLookup(dir, workspace),
      resolve: (repo: string, observation: Observation) =>
        resolveAccess(api, catalog, repo, observation),
      git: gitReader,
      env: [],
    },
  );
}

before(async () => {
  workspace = tempDir("gate-gh-repo-flag-");
  buildWorkspace(workspace, { level: "read" });
  // The clone the command runs in and the repository its -R names carry different levels, so
  // an answer that follows the wrong one is visible. demo-repo and fork-repo are read-level;
  // two-remote-repo is merge-level.
  writeCatalogLevels(workspace, {
    "demo-repo": "read",
    "fork-repo": "read",
    "two-remote-repo": "merge",
  });
  const scripts = defaultScripts(workspace);
  catalog = scripts.catalog;
  api = await loadAccessApi(scripts.access);
  assert.ok(api, "the pinned resolver did not load");
});

after(() => {
  if (workspace) removeDir(workspace);
});

test("a merge-level -R destination is allowed from a read-level clone", () => {
  const decision = decide(
    "gh pr merge 52 -R simpsonm09-org/two-remote-repo --admin --merge",
    "projects/repos/demo-repo",
  );
  assert.equal(decision.action, "inject", decision.reason);
  assert.equal(decision.level, "merge");
  assert.equal(decision.auth?.owner, "simpsonm09-org");
  assert.equal(decision.auth?.repo, "two-remote-repo");
});

test("a read-level -R destination is denied, and the reason names that destination", () => {
  const decision = decide(
    "gh pr merge 52 -R simpsonm09-org/demo-repo --admin --merge",
    "projects/repos/two-remote-repo",
  );
  assert.equal(decision.action, "deny");
  assert.match(
    decision.reason ?? "",
    /simpsonm09-org\/demo-repo denies this command at level "read"/,
  );
  assert.doesNotMatch(decision.reason ?? "", /two-remote-repo/);
});

test("a destination owner the catalog does not govern is denied", () => {
  const decision = decide(
    "gh pr merge 52 -R evil-org/two-remote-repo --admin --merge",
    "projects/repos/demo-repo",
  );
  assert.equal(decision.action, "deny");
  assert.match(
    decision.reason ?? "",
    /the destination evil-org\/two-remote-repo denies/,
  );
});

test("a personal repository named by -R is denied from an unrelated read-level clone", () => {
  const decision = decide(
    "gh pr merge 52 -R simpsonm09/two-remote-repo --admin --merge",
    "projects/repos/demo-repo",
  );
  assert.equal(decision.action, "deny");
  assert.match(
    decision.reason ?? "",
    /the destination simpsonm09\/two-remote-repo denies/,
  );
});

test("a personal fork named by -R is denied from a read-level clone", () => {
  // The personal-fork collapse is clone-relative: simpsonm09/two-remote-repo is the push fork
  // of the clone named two-remote-repo, not of the fork-repo clone this command runs in. The
  // destination is unrelated to the clone, so it is unknown, and an unknown destination reads
  // only.
  const decision = decide(
    "gh pr merge 52 -R simpsonm09/two-remote-repo --admin --merge",
    "projects/repos/fork-repo",
  );
  assert.equal(decision.action, "deny");
  assert.match(
    decision.reason ?? "",
    /the destination simpsonm09\/two-remote-repo denies/,
  );
});

test("a read of a repository on another host mints no token", () => {
  const decision = decide(
    "gh pr view 1 -R evil.com/x/demo-repo",
    "projects/repos/unlisted-repo",
  );
  assert.equal(decision.action, "pass", decision.reason);
  assert.equal(decision.auth, undefined);
});

test("a gh write with no -R is decided and named by its clone, as before", () => {
  const decision = decide(
    "gh pr merge 52 --admin --merge",
    "projects/repos/fork-repo",
  );
  assert.equal(decision.action, "deny");
  assert.match(
    decision.reason ?? "",
    /^fork-repo denies this command at level "read"/,
  );
});
