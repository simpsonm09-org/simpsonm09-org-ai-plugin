// GH_TOKEN injection must stop when the observed gh invocation could reach another host or
// cannot be pinned to the literal command the observer parsed.

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

before(async () => {
  workspace = tempDir("gate-gh-hostname-");
  buildWorkspace(workspace, { level: "full" });
  writeCatalogLevels(workspace, { "demo-repo": "full" });
  const scripts = defaultScripts(workspace);
  catalog = scripts.catalog;
  api = await loadAccessApi(scripts.access);
  assert.ok(api, "the pinned resolver did not load");
});

after(() => {
  if (workspace) removeDir(workspace);
});

function decide(
  command: string,
  options: {
    shell?: "bash" | "powershell";
    env?: string[];
  } = {},
) {
  return decideShell(
    { command, ...(options.shell ? { shell: options.shell } : {}) },
    {
      cwd: join(workspace, "projects", "repos", "demo-repo"),
      workspaceRoot: workspace,
      lookup: () => ({ repo: "demo-repo" }),
      resolve: (repo: string, observation: Observation) =>
        resolveAccess(api, catalog, repo, observation),
      git: gitReader,
      env: options.env ?? [],
    },
  );
}

test("full-level gh writes with a non-GitHub hostname pass without injection", () => {
  const decision = decide("gh api --hostname some.ghe.com --method POST /user");
  assert.equal(decision.action, "pass");
});

test("literal github.com hostnames inject in both shells and option forms", () => {
  for (const shell of ["bash", "powershell"] as const) {
    for (const hostname of ["github.com", "GitHub.COM"]) {
      assert.equal(
        decide(`gh api --hostname ${hostname} /user`, { shell }).action,
        "inject",
      );
      assert.equal(
        decide(`gh api --hostname=${hostname} /user`, { shell }).action,
        "inject",
      );
    }
  }
});

test("external and expanded hostname values never inject", () => {
  for (const shell of ["bash", "powershell"] as const) {
    for (const option of [
      "--hostname some.ghe.com",
      "--hostname=some.ghe.com",
      "--hostname $HOST",
      "--hostname=$HOST",
    ]) {
      assert.equal(decide(`gh api ${option} /user`, { shell }).action, "pass");
    }
  }
});

test("inline and inherited GH_HOST overrides do not receive the App token", () => {
  assert.equal(decide("GH_HOST=some.ghe.com gh api /user").action, "deny");
  assert.equal(decide("gh api /user", { env: ["GH_HOST"] }).action, "pass");
});

test("a non-GitHub repository host does not receive the App token", () => {
  assert.equal(
    decide("gh api /user -R some.ghe.com/owner/repo").action,
    "pass",
  );
});

test("an absolute non-GitHub gh api URL passes without injection", () => {
  const decision = decide(
    "gh api --hostname github.com https://some.ghe.com/api/v3/user",
  );
  assert.equal(decision.action, "pass");
});

test("an absolute non-GitHub gh pr URL passes without injection", () => {
  const decision = decide("gh pr view https://some.ghe.com/owner/repo/pull/1");
  assert.equal(decision.action, "pass");
});

test("an unparseable absolute URL is treated as a non-GitHub host", () => {
  assert.equal(decide("gh pr view https://[not-valid").action, "pass");
});

test("Bash expansion in gh arguments passes without injection", () => {
  assert.equal(decide("gh api $ARGS").action, "pass");
});

test("PowerShell splatting and variables pass without injection", () => {
  assert.equal(
    decide("gh api @requestArgs", { shell: "powershell" }).action,
    "pass",
  );
  assert.equal(decide("gh api $args", { shell: "powershell" }).action, "pass");
});

test("destination-changing environment names prevent injection", () => {
  for (const name of ["GH_REPO", "GH_CONFIG_DIR"]) {
    assert.equal(decide("gh pr list", { env: [name] }).action, "pass", name);
  }
});

test("unknown gh commands and unmodeled arguments pass without injection", () => {
  assert.equal(decide("gh leak").action, "pass");
  assert.equal(decide("gh leak view").action, "pass");
  assert.equal(decide("gh extension exec leak").action, "pass");
  assert.equal(decide("gh run view --log").action, "pass");
});

test("literal GitHub-targeted gh commands still inject", () => {
  for (const command of [
    "gh api /user",
    "gh api --hostname github.com /user",
    "gh pr view 1",
    "gh pr list",
  ]) {
    assert.equal(decide(command).action, "inject", command);
  }
});

test("hostname literal parsing works in PowerShell", () => {
  assert.equal(
    decide("gh api --hostname github.com /user", {
      shell: "powershell",
    }).action,
    "inject",
  );
  assert.equal(
    decide("gh api --hostname some.ghe.com /user", {
      shell: "powershell",
    }).action,
    "pass",
  );
});
