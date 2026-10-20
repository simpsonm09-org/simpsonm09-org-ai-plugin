// Explicit GitHub destinations remain governed outside fleet clones. These tests use the real
// fleet lookup and hash-verified resolver; the temporary caller directory has no git metadata.

import assert from "node:assert/strict";
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
let outside = "";
let catalog = "";
/** @type {Awaited<ReturnType<typeof loadAccessApi>>} */
let api = null;
let resolverRepo = "unset";

function decide(
  command: string,
  options: { shell?: "bash" | "powershell"; runtime?: "codex" } = {},
) {
  return decideShell(
    { command, ...options },
    {
      cwd: outside,
      workspaceRoot: workspace,
      lookup: (dir: string) => fleetLookup(dir, workspace),
      resolve: (repo: string, observation: Observation) => {
        resolverRepo = repo;
        return resolveAccess(api, catalog, repo, observation);
      },
      git: gitReader,
      env: [],
    },
  );
}

before(async () => {
  workspace = tempDir("gate-outside-fleet-workspace-");
  outside = tempDir("gate-outside-fleet-caller-");
  buildWorkspace(workspace, { level: "read" });
  writeCatalogLevels(workspace, {
    "demo-repo": "propose",
    "two-remote-repo": "merge",
  });
  const scripts = defaultScripts(workspace);
  catalog = scripts.catalog;
  api = await loadAccessApi(scripts.access);
  assert.ok(api, "the pinned resolver did not load");
});

after(() => {
  if (workspace) removeDir(workspace);
  if (outside) removeDir(outside);
});

test("outside-fleet admin writes use the explicitly pinned organization destination", () => {
  for (const command of [
    "gh label create gate-probe -R simpsonm09-org/simpsonm09-gate-probe-missing",
    "gh pr merge 1 -R simpsonm09-org/simpsonm09-repo-catalog --admin",
    "gh repo delete simpsonm09-org/simpsonm09-repo-catalog --yes",
  ]) {
    const decision = decide(command);
    assert.equal(decision.action, "deny", command);
    assert.match(decision.reason ?? "", /simpsonm09-org\/.*level/, command);
    assert.match(
      decision.reason ?? "",
      new RegExp(`at level "${decision.level}"`),
      command,
    );
    assert.equal(decision.repo, null);
    assert.equal(
      resolverRepo,
      "",
      "resolver must receive no local clone identity",
    );
  }
});

test("outside-fleet organization merge follows the destination access level", () => {
  const command =
    "gh pr merge 52 -R simpsonm09-org/two-remote-repo --admin --merge";
  const allowed = decide(command);
  assert.equal(allowed.action, "pass");
  assert.equal(allowed.level, "merge");
  assert.equal(
    allowed.auth,
    undefined,
    "outside-fleet commands use ambient auth",
  );

  writeCatalogLevels(workspace, {
    "demo-repo": "propose",
    "two-remote-repo": "propose",
  });
  const denied = decide(command);
  assert.equal(denied.action, "deny");
  assert.equal(denied.level, "propose");
  assert.match(
    denied.reason ?? "",
    /simpsonm09-org\/two-remote-repo denies .* at level "propose"/,
  );
});

test("an organization repository missing from the catalog is denied outside the fleet", () => {
  const decision = decide(
    "gh pr merge 1 -R simpsonm09-org/not-in-catalog --admin",
  );
  assert.equal(decision.action, "deny");
  assert.match(decision.reason ?? "", /simpsonm09-org\/not-in-catalog/);
});

test("a third-party repository pinned outside the fleet is denied as unknown", () => {
  const decision = decide("gh pr merge 1 -R third-party/repo --admin");
  assert.equal(decision.action, "deny");
  assert.match(decision.reason ?? "", /third-party\/repo/);
});

test("an explicitly pinned read passes outside the fleet", () => {
  const decision = decide("gh pr view 1 -R simpsonm09-org/demo-repo");
  assert.equal(decision.action, "pass");
  assert.equal(decision.auth, undefined);
});

test("an unpinned write still passes outside the fleet", () => {
  const decision = decide("gh pr merge 1 --admin");
  assert.equal(decision.action, "pass");
  assert.equal(decision.repo, null);
});

test("PowerShell explicit destinations are resolved outside the fleet", () => {
  const decision = decide(
    "& gh pr merge 1 -R simpsonm09-org/simpsonm09-repo-catalog --admin",
    { shell: "powershell" },
  );
  assert.equal(decision.action, "deny");
  assert.match(
    decision.reason ?? "",
    /simpsonm09-org\/simpsonm09-repo-catalog/,
  );
});

test("Codex continues to deny every governed outside-fleet write", () => {
  const decision = decide(
    "gh pr merge 52 -R simpsonm09-org/two-remote-repo --admin --merge",
    { runtime: "codex" },
  );
  assert.equal(decision.action, "deny");
  assert.match(decision.reason ?? "", /Codex/);
});
