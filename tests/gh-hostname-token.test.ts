// App-token injection is restricted to gh commands that the observer can show target
// github.com. These checks use decideShell with the real fixture resolver and git state.

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
} from "./support/fixture-workspace.mjs";

let workspace = "";
let catalog = "";
let demo = "";
/** @type {Awaited<ReturnType<typeof loadAccessApi>>} */
let api = null;

before(async () => {
  workspace = tempDir("gh-hostname-token-");
  buildWorkspace(workspace, { level: "propose" });
  demo = join(workspace, "projects", "repos", "demo-repo");
  const scripts = defaultScripts(workspace);
  catalog = scripts.catalog;
  api = await loadAccessApi(scripts.access);
  assert.ok(api, "the pinned resolver did not load");
});

after(() => {
  if (workspace) removeDir(workspace);
});

/**
 * @param {string} command
 * @param {"bash" | "powershell"} [shell]
 * @param {string[]} [env]
 */
function decide(
  command: string,
  shell: "bash" | "powershell" = "bash",
  env: string[] = [],
) {
  return decideShell(
    { command, shell },
    {
      cwd: demo,
      workspaceRoot: workspace,
      lookup: (dir: string) => fleetLookup(dir, workspace),
      resolve: (repo: string, observation: Observation) =>
        resolveAccess(api, catalog, repo, observation),
      git: gitReader,
      env,
    },
  );
}

test("an explicit github.com hostname keeps injection in Bash and PowerShell", () => {
  for (const shell of ["bash", "powershell"] as const) {
    assert.equal(
      decide("gh api --hostname github.com /user", shell).action,
      "inject",
    );
    assert.equal(
      decide("gh api --hostname=GitHub.COM /user", shell).action,
      "inject",
    );
  }
});

test("a non-github or expanded hostname passes without the App token", () => {
  for (const shell of ["bash", "powershell"] as const) {
    assert.equal(
      decide("gh api --hostname some.ghe.com /user", shell).action,
      "pass",
    );
    assert.equal(
      decide("gh api --hostname=some.ghe.com /user", shell).action,
      "pass",
    );
    assert.equal(decide("gh api --hostname $HOST /user", shell).action, "pass");
    assert.equal(decide("gh api --hostname=$HOST /user", shell).action, "pass");
  }
});

test("an inline GH_HOST assignment does not receive the App token", () => {
  const decision = decide("GH_HOST=some.ghe.com gh api /user");
  assert.equal(decision.action, "deny");
});

test("an inherited GH_HOST name does not receive the App token", () => {
  assert.equal(decide("gh api /user", "bash", ["GH_HOST"]).action, "pass");
});

test("a non-github.com -R destination does not receive the App token", () => {
  assert.equal(
    decide("gh api /user -R some.ghe.com/owner/repo").action,
    "pass",
  );
});

test("gh api without a host signal keeps injection", () => {
  assert.equal(decide("gh api /user").action, "inject");
});
