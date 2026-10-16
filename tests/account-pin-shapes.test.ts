// The account-pinning forms the working agreements document, decided with a fake resolver and a
// fake git port. The strings contain `gh auth token` but nothing runs it: the string is passed
// to the observer, which reads words. The point of these tests is that the supported forms are a
// single command and are observed, while the equally natural multi-statement pin is a compound
// command and is denied with a precise reason that neither says the repository is unknown nor
// tells the caller to re-run the command through another shell, tool, wrapper, or identity.

import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { decideShell, denyCommand } from "../gate.mjs";

const ws = resolve("pin-workspace");
const cwd = join(ws, "projects", "repos", "demo-repo");

// A read-only git port that names the organization clone's single remote.
function readerFor(url: string | null) {
  return (args: string[]) => {
    const key = args.join(" ");
    if (key === "remote") return "origin";
    if (key.startsWith("remote get-url")) return url;
    return null;
  };
}

/** The observation the decision passed to the resolver, captured for one cell. */
function spyDeps(result: { code: number; stdout: string }) {
  const calls: Array<{
    repo: string;
    observation: import("../lib/observation.mjs").Observation;
  }> = [];
  return {
    calls,
    deps: {
      cwd,
      workspaceRoot: ws,
      resolve: (
        repo: string,
        observation: import("../lib/observation.mjs").Observation,
      ) => {
        calls.push({ repo, observation });
        return result;
      },
      git: () => readerFor("https://github.com/simpsonm09-org/demo-repo.git"),
      env: [],
    },
  };
}

const ORG_ALLOWED = JSON.stringify({
  level: "propose",
  contextLevel: "propose",
  capability: "openPr",
  allowed: true,
  kind: "org",
  destination: "simpsonm09-org/demo-repo",
  auth: { route: "app", owner: "simpsonm09-org", repo: "demo-repo" },
});
const PUSH_ALLOWED = JSON.stringify({
  level: "propose",
  contextLevel: "propose",
  capability: "pushBranch",
  allowed: true,
  kind: "org",
  destination: "simpsonm09-org/demo-repo",
  auth: { route: "ambient", owner: null, repo: null },
});
const UNRESOLVED = JSON.stringify({
  level: "propose",
  contextLevel: "propose",
  capability: null,
  allowed: false,
  kind: "unknown",
  destination: null,
  auth: { route: "ambient", owner: null, repo: null },
});

test("the documented single-command account prefix is one observed gh command", () => {
  const spy = spyDeps({ code: 0, stdout: ORG_ALLOWED });
  const decision = decideShell(
    {
      command:
        'GH_TOKEN="$(gh auth token --user simpsonm09)" gh pr create -R simpsonm09-org/demo-repo --title x',
    },
    spy.deps,
  );
  // The caller pinned their own token, so the gate passes the command through unchanged: it is
  // one observed gh command, not a compound one, and needs no organization App token.
  assert.equal(decision.action, "pass");
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].observation.operation, "openPr");
  assert.equal(spy.calls[0].observation.destination?.owner, "simpsonm09-org");
  assert.equal(spy.calls[0].observation.destination?.repo, "demo-repo");
});

test("the documented git credential-helper push is one observed git command", () => {
  const spy = spyDeps({ code: 0, stdout: PUSH_ALLOWED });
  const decision = decideShell(
    {
      command:
        "git -c credential.helper= -c 'credential.helper=!f() { :; }; f' push https://github.com/simpsonm09-org/demo-repo.git feat/x",
    },
    spy.deps,
  );
  assert.equal(decision.action, "pass");
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].observation.operation, "push");
  assert.equal(spy.calls[0].observation.destination?.owner, "simpsonm09-org");
  assert.equal(spy.calls[0].observation.destination?.repo, "demo-repo");
});

test("a two-statement bash pin is a compound command and is denied precisely", () => {
  const decision = decideShell(
    {
      command:
        'export GH_TOKEN="$(gh auth token --user simpsonm09)"; gh pr create -R simpsonm09-org/demo-repo --title x',
    },
    spyDeps({ code: 1, stdout: UNRESOLVED }).deps,
  );
  assert.equal(decision.action, "deny");
  assert.match(decision.reason ?? "", /compound command/);
  assert.doesNotMatch(decision.reason ?? "", /destination unknown/i);
  assert.doesNotMatch(
    decision.reason ?? "",
    /retry|re-run|another shell|wrapper/i,
  );
});

test("a bare assignment followed by a gh command is a compound command and is denied", () => {
  const decision = decideShell(
    {
      command:
        'GH_TOKEN="$(gh auth token --user simpsonm09)"; gh pr create -R simpsonm09-org/demo-repo --title x',
    },
    spyDeps({ code: 1, stdout: UNRESOLVED }).deps,
  );
  assert.equal(decision.action, "deny");
  assert.match(decision.reason ?? "", /compound command/);
});

test("the PowerShell environment assignment has no single-command form and is denied", () => {
  const decision = decideShell(
    {
      command:
        "$env:GH_TOKEN = (gh auth token --user simpsonm09); gh pr create -R simpsonm09-org/demo-repo --title x",
      shell: "powershell",
    },
    spyDeps({ code: 1, stdout: UNRESOLVED }).deps,
  );
  assert.equal(decision.action, "deny");
  assert.match(decision.reason ?? "", /compound command/);
  assert.doesNotMatch(decision.reason ?? "", /destination unknown/i);
});

test("a denial is final: the message names the shape, never a rerun path", () => {
  const reason =
    "a compound command containing a governed write is not observed as separate commands, so the write is denied";
  const message = denyCommand(reason);
  assert.match(message, /compound command/);
  assert.doesNotMatch(message, /retry|re-run|another shell|wrapper|identity/i);
});
