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
 * @param {"bash" | "powershell"} [shell]
 * @returns {import("../gate.mjs").Decision}
 */
function decide(level: string, command: string, shell?: "bash" | "powershell") {
  const found = fixture(level);
  return decideShell(
    { command, ...(shell ? { shell } : {}) },
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

/**
 * @param {string} level
 * @param {string} command
 * @param {"bash" | "powershell"} [shell]
 */
function observe(
  level: string,
  command: string,
  shell?: "bash" | "powershell",
) {
  const found = fixture(level);
  return observeShellCommand(found.demo, command, {
    shell,
    git: gitPort(found.demo),
  });
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
  assert.match(
    denied.reason ?? "",
    /demo-repo denies this command at level "read"/,
  );

  // The writing GraphQL document keeps the admin classification the resolver already had.
  assert.equal(
    decide("propose", "gh api graphql -f query='mutation { addStar }'").action,
    "deny",
  );
});

test("a GraphQL field the shell would expand is a conservative admin write", () => {
  const bash = [
    'gh api graphql -f query="$(echo bXV0YXRpb24= | base64 -d)"',
    'gh api graphql -f query="`cat q.graphql`"',
    'gh api graphql -f query="$MUT"',
    String.raw`gh api graphql -f query=$'\x6dutation{addStar(input:{starrableId:"x"}){clientMutationId}}'`,
    'gh api graphql -F query="$(cat q.graphql)"',
    'gh api graphql --field query="$(cat q.graphql)"',
    "gh api graphql -f query='query { viewer { login } }' -f variables=\"$VARS\"",
    "gh api graphql -f query='query { a }' -f operationName=\"$OP\"",
    "gh api graphql -f query=query{viewer{login}}",
  ];
  for (const command of bash) {
    const observed = observe("propose", command);
    assert.equal(observed.capability, "admin", command);
    assert.equal(observed.operation, "admin", command);
    assert.equal(observed.readOnly, false, command);
    assert.equal(decide("propose", command).action, "deny", command);
  }

  const powershell = [
    'gh api graphql -f query="$(Get-Content q.graphql)"',
    'gh api graphql -f query="$env:MUT"',
  ];
  for (const command of powershell) {
    const observed = observe("propose", command, "powershell");
    assert.equal(observed.capability, "admin", command);
    assert.equal(observed.operation, "admin", command);
    assert.equal(observed.readOnly, false, command);
    assert.equal(
      decide("propose", command, "powershell").action,
      "deny",
      command,
    );
  }
});

test("a literal GraphQL field stays a read, including real variable syntax", () => {
  // A real query uses `$var` references and the `{owner}` placeholder; both are inside single
  // quotes, so the shell hands the text over unchanged in either dialect.
  const read = [
    "gh api graphql -F owner=x -f query='query($owner: String!) { repository(owner: $owner, name: \"r\") { id } }'",
    "gh api graphql -F owner='{owner}' -f query='query { viewer { login } }'",
    "gh api graphql -f query='query { viewer { login } }' -f operationName='Viewer'",
    "gh api graphql -t '{{.data.viewer.login}}' -f query='query{viewer{login}}'",
  ];
  for (const command of read) {
    const observed = observe("propose", command);
    assert.equal(observed.capability, null, command);
    assert.equal(observed.readOnly, true, command);
    assert.equal(decide("propose", command).action, "inject", command);
    const powershell = observe("propose", command, "powershell");
    assert.equal(powershell.capability, null, command);
    assert.equal(
      decide("propose", command, "powershell").action,
      "inject",
      command,
    );
  }
});

test("a GitHub PR URL supplies its destination and conflicts with a different -R", () => {
  const other = "https://github.com/other-org/other-repo/pull/7";
  for (const [command, resolved] of [
    [`gh pr ready ${other}`, true],
    [`gh pr ready ${other} -R simpsonm09-org/demo-repo`, false],
  ] as const) {
    const observed = observe("propose", command);
    assert.equal(observed.operation, "openPr", command);
    assert.equal(observed.resolved, resolved, command);
    assert.deepEqual(
      observed.destination,
      resolved
        ? { host: "github.com", owner: "other-org", repo: "other-repo" }
        : null,
      command,
    );
    assert.equal(decide("propose", command).action, "deny", command);
  }
  for (const [command, resolved] of [
    [`gh pr merge ${other}`, true],
    [`gh pr merge ${other} -R simpsonm09-org/demo-repo`, false],
  ] as const) {
    const observed = observe("merge", command);
    assert.equal(observed.operation, "mergePr", command);
    assert.equal(observed.resolved, resolved, command);
    assert.deepEqual(
      observed.destination,
      resolved
        ? { host: "github.com", owner: "other-org", repo: "other-repo" }
        : null,
      command,
    );
    assert.equal(decide("merge", command).action, "deny", command);
  }

  // A URL to the destination itself, in any letter case, keeps the resolved destination.
  const same = "https://GitHub.com/SimpsonM09-Org/Demo-Repo/pull/7";
  assert.equal(decide("propose", `gh pr ready ${same}`).action, "inject");
  assert.equal(decide("merge", `gh pr merge ${same}`).action, "inject");

  // A command with no URL positional is unchanged.
  assert.equal(decide("propose", "gh pr ready 7").action, "inject");
  assert.equal(decide("merge", "gh pr merge 7").action, "inject");
});

test("gh pr ready --undo is openPr by owner decision", () => {
  // Un-marking ready is a state change on an open pull request, so the owner keeps it at the
  // openPr capability the pull request create/ready path already uses.
  for (const command of ["gh pr ready --undo 1", "gh pr ready 1 --undo"]) {
    const observed = observe("propose", command);
    assert.equal(observed.operation, "openPr", command);
    assert.equal(observed.capability, "openPr", command);
    assert.equal(decide("propose", command).action, "inject", command);
    assert.equal(decide("merge", command).action, "inject", command);
    assert.equal(decide("read", command).action, "deny", command);
  }
});

test("gh api keeps -t, -p, and --allow-escape-sequences in the modeled table", () => {
  const read = [
    "gh api graphql -t '{{.data.viewer.login}}' -f query='query{viewer{login}}'",
    "gh api graphql -p machine-man --allow-escape-sequences -f query='query { viewer { login } }'",
    "gh api graphql --cache 60s -f query='query { viewer { login } }'",
  ];
  for (const command of read) {
    const observed = observe("propose", command);
    assert.equal(observed.capability, null, command);
    assert.equal(observed.readOnly, true, command);
    assert.equal(decide("propose", command).action, "inject", command);
  }
});
