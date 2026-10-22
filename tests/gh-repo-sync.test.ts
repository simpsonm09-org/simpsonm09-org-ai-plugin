// The narrow `gh repo sync` exception uses the real gate and pinned resolver. The fixture has
// only local git remotes and a committed catalog, so these decisions need no network or auth.

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

function decide(
  command: string,
  shell: "bash" | "powershell" = "bash",
  cwd = join(workspace, "projects", "repos", "fork-repo"),
) {
  return decideShell(
    { command, shell },
    {
      cwd,
      workspaceRoot: workspace,
      lookup: (dir: string) => fleetLookup(dir, workspace),
      resolve: (repo: string, observation: Observation) =>
        resolveAccess(api, catalog, repo, observation),
      git: gitReader,
      env: [],
    },
  );
}

function setLevel(level: string) {
  writeCatalogLevels(workspace, { "fork-repo": level });
}

before(async () => {
  workspace = tempDir("gate-gh-repo-sync-");
  buildWorkspace(workspace);
  const scripts = defaultScripts(workspace);
  catalog = scripts.catalog;
  api = await loadAccessApi(scripts.access);
  assert.ok(api, "the pinned resolver did not load");
});

after(() => {
  if (workspace) removeDir(workspace);
});

for (const level of ["propose", "merge"]) {
  for (const shell of ["bash", "powershell"] as const) {
    for (const suffix of [
      "",
      " --branch main",
      " --source simpsonm09-org/fork-repo",
      " --branch main --source simpsonm09-org/fork-repo",
    ]) {
      test(`${level} personal-fork sync passes without injection (${shell}${suffix ? `,${suffix}` : ""})`, () => {
        setLevel(level);
        const decision = decide(
          `gh repo sync simpsonm09/fork-repo${suffix}`,
          shell,
        );
        assert.equal(decision.action, "pass", decision.reason);
        assert.equal(decision.level, level);
        assert.equal(decision.auth, undefined);
      });
    }
  }
}

test("a read-level personal-fork sync is denied", () => {
  setLevel("read");
  assert.equal(decide("gh repo sync simpsonm09/fork-repo").action, "deny");
});

test("an unresolved clone context keeps the personal-fork sync denied with a focused reason", () => {
  setLevel("merge");
  const command =
    "gh repo sync simpsonm09/fork-repo --source simpsonm09-org/fork-repo";
  const decision = decide(command, "bash", workspace);

  assert.equal(decision.action, "deny");
  assert.equal(decision.repo, null);
  assert.equal(decision.level, "none");
  assert.match(decision.reason ?? "", /local repository context/);
  assert.match(
    decision.reason ?? "",
    /denial is final and the blocked command cannot be automatically retried/,
  );
  assert.match(decision.reason ?? "", /for the fork-repo clone/);
  assert.doesNotMatch(decision.reason ?? "", /run|retry|working directory/i);
  assert.doesNotMatch(decision.reason ?? "", /[A-Za-z]:\\|\\\\/);

  const recognized = decide(command);
  assert.equal(recognized.action, "pass", recognized.reason);
  assert.equal(recognized.level, "merge");
});

test("an omitted source keeps the existing root-context denial", () => {
  setLevel("merge");
  const decision = decide(
    "gh repo sync simpsonm09/fork-repo",
    "bash",
    workspace,
  );

  assert.equal(decision.action, "deny");
  assert.equal(
    decision.reason,
    'the destination simpsonm09/fork-repo denies admin at level "none"',
  );
});

test("a different source keeps the existing denial without a context hint", () => {
  setLevel("merge");
  const decision = decide(
    "gh repo sync simpsonm09/fork-repo --source other-org/fork-repo",
    "bash",
    workspace,
  );

  assert.equal(decision.action, "deny");
  assert.equal(
    decision.reason,
    'the destination simpsonm09/fork-repo denies admin at level "none"',
  );
});

test("a matching source for a repository outside the roster keeps the existing denial", () => {
  setLevel("merge");
  const decision = decide(
    "gh repo sync simpsonm09/rogue-repo --source simpsonm09-org/rogue-repo",
    "bash",
    workspace,
  );

  assert.equal(decision.action, "deny");
  assert.equal(
    decision.reason,
    'the destination simpsonm09/rogue-repo denies admin at level "none"',
  );
});

test("a matching source without enough roster access keeps the existing denial", () => {
  setLevel("read");
  const decision = decide(
    "gh repo sync simpsonm09/fork-repo --source simpsonm09-org/fork-repo",
    "bash",
    workspace,
  );

  assert.equal(decision.action, "deny");
  assert.equal(
    decision.reason,
    'the destination simpsonm09/fork-repo denies admin at level "none"',
  );
});

test("a third-party destination keeps the existing denial", () => {
  setLevel("merge");
  const decision = decide(
    "gh repo sync michael-denyer/pstack-claude --source simpsonm09-org/pstack-claude",
    "bash",
    workspace,
  );

  assert.equal(decision.action, "deny");
  assert.equal(
    decision.reason,
    'the destination michael-denyer/pstack-claude denies admin at level "none"',
  );
});

test("a non-GitHub host keeps the existing denial", () => {
  setLevel("merge");
  const decision = decide(
    "gh --hostname github.example repo sync simpsonm09/fork-repo --source simpsonm09-org/fork-repo",
    "bash",
    workspace,
  );

  assert.equal(decision.action, "deny");
  assert.equal(
    decision.reason,
    'the gh verb "--hostname github.example" has no precise capability; it is treated as an admin write; outside the fleet, run the write from the fleet clone or pin -R OWNER/REPO to a GitHub repository',
  );
});

for (const [name, command, shell] of [
  ["no positional repository", "gh repo sync", "bash"],
  ["force", "gh repo sync simpsonm09/fork-repo --force", "bash"],
  ["short force", "gh repo sync simpsonm09/fork-repo -f", "bash"],
  [
    "non-main branch",
    "gh repo sync simpsonm09/fork-repo --branch feature",
    "bash",
  ],
  [
    "different source",
    "gh repo sync simpsonm09/fork-repo --source other-org/fork-repo",
    "bash",
  ],
  ["owned fork", "gh repo sync simpsonm09/pstack-max", "bash"],
  ["recorded upstream", "gh repo sync michael-denyer/pstack-claude", "bash"],
  ["organization destination", "gh repo sync simpsonm09-org/fork-repo", "bash"],
  ["nonliteral Bash repository", "gh repo sync $REPO", "bash"],
  ["nonliteral PowerShell repository", "gh repo sync $repo", "powershell"],
  ["unmodeled option", "gh repo sync simpsonm09/fork-repo --dry-run", "bash"],
  [
    "explicit local override",
    "gh repo sync simpsonm09/fork-repo -R simpsonm09/fork-repo",
    "bash",
  ],
] as const) {
  test(`${name} stays denied at merge`, () => {
    setLevel("merge");
    assert.equal(decide(command, shell).action, "deny");
  });
}

test("an out-of-shape sync keeps its pushMain verdict: allowed at full, denied at merge", () => {
  for (const command of [
    "gh repo sync simpsonm09/fork-repo --force",
    "gh repo sync simpsonm09/fork-repo --branch feature",
  ]) {
    setLevel("full");
    assert.notEqual(decide(command).action, "deny", command);
    setLevel("merge");
    assert.equal(decide(command).action, "deny", command);
  }
});
