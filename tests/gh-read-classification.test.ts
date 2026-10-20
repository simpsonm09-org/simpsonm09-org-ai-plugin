// Two classification fixes, asserted at the observer and through the real decision path.
// A read-only `gh api graphql` query is a read (it used to be an admin write because it sends
// a body), and `gh pr ready`/`--undo` is an openPr operation rather than a conservative admin
// write. The end-to-end half runs gate.mjs decideShell over the observer and the pinned,
// hash-verified resolver with a committed fixture catalog: no network, no gh, no spawned token
// broker.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  defaultScripts,
  loadAccessApi,
  observeShellCommand,
  resolveAccess,
} from "../access.mjs";
import { decideShell } from "../gate.mjs";
import {
  buildWorkspace,
  removeDir,
  tempDir,
} from "./support/fixture-workspace.mjs";

type Api = Awaited<ReturnType<typeof loadAccessApi>>;

interface Fixture {
  workspace: string;
  scripts: ReturnType<typeof defaultScripts>;
  demo: string;
}

const LEVELS = ["read", "propose", "merge"];
const fixtures = new Map<string, Fixture>();
let api: Api = null;

before(async () => {
  for (const level of LEVELS) {
    const dir = tempDir(`gh-classification-${level}-`);
    const { workspace } = buildWorkspace(dir, { level });
    fixtures.set(level, {
      workspace,
      scripts: defaultScripts(workspace),
      demo: join(workspace, "projects", "repos", "demo-repo"),
    });
  }
  api = await loadAccessApi(fixtures.get("propose")?.scripts.access ?? "");
  assert.ok(api, "the packaged resolver must load");
});

after(() => {
  for (const fixture of fixtures.values()) removeDir(fixture.workspace);
});

/**
 * @param {string} level
 * @returns {Fixture}
 */
function fixture(level: string): Fixture {
  const found = fixtures.get(level);
  assert.ok(found, level);
  return found;
}

// A read-only git port bound to the fixture clone, so the observer resolves a gh command's
// destination from the clone's real remotes.
/**
 * @param {string} cwd
 * @returns {(args: string[]) => string | null}
 */
function gitPort(cwd: string) {
  return (args: string[]): string | null => {
    try {
      return execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }).trim();
    } catch {
      return null;
    }
  };
}

/**
 * @param {string} level
 * @param {string} command
 * @returns {import("../gate.mjs").Decision}
 */
function decide(level: string, command: string) {
  const found = fixture(level);
  return decideShell(
    { command },
    {
      cwd: found.demo,
      workspaceRoot: found.workspace,
      lookup: () => ({ repo: "demo-repo" }),
      resolve: (repo, observation) =>
        resolveAccess(api, found.scripts.catalog, repo, observation),
      git: (cwd) => gitPort(cwd),
      env: [],
    },
  );
}

test("a read-only gh api graphql query is a read", () => {
  const read = [
    "gh api graphql -f query='query { viewer { login } }'",
    "gh api graphql -f query='query { viewer { login } }' -F owner=org -f name=demo",
    "gh api --paginate graphql -f query='query { viewer { login } }'",
    "gh api graphql -X POST -f query='query { viewer { login } }'",
    "gh api graphql -f query='QUERY { viewer { login } }'",
    "gh api graphql -F query='query { viewer { login } }' -F cursor=abc",
  ];
  for (const command of read) {
    const observed = observeShellCommand(fixture("propose").demo, command);
    assert.equal(observed.capability, null, command);
    assert.equal(observed.readOnly, true, command);
    assert.equal(observed.operation, "read", command);
    assert.equal(observed.kind, "read", command);
  }
});

test("a graphql document that writes stays a conservative admin write", () => {
  const write = [
    "gh api graphql -f query='mutation { addStar }'",
    "gh api graphql -f query='subscription { x }'",
    "gh api graphql -f query='query { a } mutation { b }'",
    "gh api graphql -F query=@file.graphql",
    "gh api graphql -f query='query { a }' -F cursor=@cursor.txt",
    "gh api graphql -f query='query { a }' --input body.json",
    "gh api graphql -X DELETE -f query='query { a }'",
    "gh api graphql -f query=a -f query=b",
    "gh api graphql -f owner=org",
    "gh api graphql -F query='query { a }' --nope",
    "gh api repos/o/r -f query='query { a }'",
  ];
  for (const command of write) {
    const observed = observeShellCommand(fixture("propose").demo, command);
    assert.equal(observed.capability, "admin", command);
    assert.equal(observed.operation, "admin", command);
    assert.equal(observed.readOnly, false, command);
  }
});

test("gh pr ready and --undo are openPr operations, not admin writes", () => {
  const cases = [
    "gh pr ready 1 -R simpsonm09-org/demo-repo",
    "gh pr ready --undo 1 -R simpsonm09-org/demo-repo",
    "gh pr ready 1 -R simpsonm09-org/demo-repo --undo",
    "gh pr ready 1",
  ];
  for (const command of cases) {
    const observed = observeShellCommand(fixture("propose").demo, command);
    assert.equal(observed.operation, "openPr", command);
    assert.equal(observed.capability, "openPr", command);
    assert.equal(observed.readOnly, false, command);
    assert.equal(observed.resolved, true, command);
    // gh pr ready has no --base/--head, so the resolver sees both sides absent.
    assert.equal(observed.base, null, command);
    assert.equal(observed.head, null, command);
  }
});

test("the gate grants the graphql read and gh pr ready through the pinned resolver", () => {
  for (const command of [
    "gh api graphql -f query='query { viewer { login } }'",
    "gh api graphql -f query='query { viewer { login } }' -F owner=org -f name=demo",
    "gh api --paginate graphql -f query='query { viewer { login } }'",
  ]) {
    assert.equal(decide("propose", command).action, "inject", command);
  }

  // Marking a draft ready is part of opening a pull request, so propose and merge grant it
  // and read does not.
  assert.equal(decide("propose", "gh pr ready 1").action, "inject");
  assert.equal(decide("merge", "gh pr ready 1").action, "inject");
  const denied = decide("read", "gh pr ready 1");
  assert.equal(denied.action, "deny");
  assert.match(denied.reason ?? "", /demo-repo denies this command at level "read"/);

  // The writing GraphQL document keeps the admin classification the resolver already had.
  assert.equal(
    decide("propose", "gh api graphql -f query='mutation { addStar }'").action,
    "deny",
  );
});
