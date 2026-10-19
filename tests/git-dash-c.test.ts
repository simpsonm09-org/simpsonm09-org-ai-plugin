// The `git -C` destination fix: a `git -C <path> push` observes the remotes and refs of the
// clone it names, so the local repository the resolver sees must be looked up in that clone
// too, not in the tool's cwd — and a `-C` outside the fleet must fail closed. Pure tests:
// fake git readers answer the git queries, a fake lookup answers the fleet question, and the
// resolver is a stub. No git subprocess, no catalog, no network, no credentials.

import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { commandDirectory } from "../lib/gitflags.mjs";
import { observeCommand, observationDestination } from "../lib/intent.mjs";
import { decideShell } from "../gate.mjs";
import type { Observation } from "../lib/observation.mjs";

const ws = resolve("ws-root");
const cwdA = join(ws, "projects", "repos", "repo-a");
const cloneB = join(ws, "projects", "repos", "repo-b");
const outside = join(ws, "projects", "other");

// The fleet lookup one clone at a time: a directory that is a fleet clone answers its
// repository name, and no other directory does.
/**
 * @param {Record<string, string | null>} dirs fleet directory to repository name
 */
function lookupFor(dirs: Record<string, string | null>) {
  const known = new Map(
    Object.entries(dirs).map(([dir, repo]) => [resolve(dir), repo] as const),
  );
  return (dir: string): { repo: string | null } => ({
    repo: known.get(resolve(dir)) ?? null,
  });
}

// The stub resolver records what the gate asked it (the repository name that decides the
// policy) and answers with the given CLI result.
/**
 * @param {{ code: number, stdout: string }} result
 */
function resolver(result: { code: number; stdout: string }) {
  const calls: Array<{ repo: string; observation: Observation }> = [];
  return {
    calls,
    resolve: (repo: string, observation: Observation) => {
      calls.push({ repo, observation });
      return result;
    },
  };
}

// A git reader for one clone: it answers the queries the way that clone's configuration
// answers them, ignoring the `-C` pairs the command put in front of every read.
type FakeGit = (args: string[]) => string | null;
/**
 * @param {{ origin: string, defaultBranch: string, branches: string[] }} clone
 * @returns {FakeGit}
 */
function gitReaderFor(clone: {
  origin: string;
  defaultBranch: string;
  branches: string[];
}): FakeGit {
  return (args: string[]) => {
    let index = 0;
    while (args[index] === "-C" || args[index] === "-c") index += 2;
    const question = args.slice(index).join(" ");
    if (question === "remote") return "origin";
    if (
      question === "remote get-url --push --all origin" ||
      question === "remote get-url origin"
    )
      return clone.origin;
    if (question === "symbolic-ref --quiet refs/remotes/origin/HEAD")
      return `refs/remotes/origin/${clone.defaultBranch}`;
    const ref = /^show-ref --verify (refs\/(?:heads|tags)\/.+)$/.exec(question);
    if (ref) {
      const name = ref[1];
      const branch = name.startsWith("refs/heads/")
        ? name.slice("refs/heads/".length)
        : null;
      if (branch && clone.branches.includes(branch)) return "f".repeat(40);
      return null;
    }
    return null;
  };
}

// The git dep one observeShellCommand-like call supplies: it hands the reader out for the
// directory it is asked for, as the adapters do.
function gitAs(clone: {
  origin: string;
  defaultBranch: string;
  branches: string[];
}) {
  return () => gitReaderFor(clone);
}

test("a push through -C is classified against the clone the command names", () => {
  const spy = resolver({
    code: 0,
    stdout: JSON.stringify({
      level: "propose",
      kind: "org",
      auth: { route: "ambient", owner: null, repo: null },
    }),
  });
  const decision = decideShell(
    { command: `git -C "${cloneB}" push origin feat/x` },
    {
      cwd: cwdA,
      lookup: lookupFor({ [cwdA]: "repo-a", [cloneB]: "repo-b" }),
      resolve: spy.resolve,
      git: gitAs({
        origin: "https://github.com/simpsonm09/repo-b.git",
        defaultBranch: "main",
        branches: ["feat/x"],
      }),
      env: [],
    },
  );
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].repo, "repo-b", "the -C clone's name decides");
  assert.deepEqual(
    observationDestination(spy.calls[0].observation),
    { host: "github.com", destination: "simpsonm09/repo-b" },
  );
  assert.equal(spy.calls[0].observation.capability, "pushBranch");
  assert.equal(decision.action, "pass");
  assert.equal(decision.repo, "repo-b");
});

test("a relative -C is read against the caller's cwd", () => {
  const spy = resolver({
    code: 0,
    stdout: JSON.stringify({
      level: "propose",
      kind: "org",
      auth: { route: "ambient", owner: null, repo: null },
    }),
  });
  const decision = decideShell(
    { command: "git -C ../repo-b push origin feat/x" },
    {
      cwd: cwdA,
      lookup: lookupFor({ [cwdA]: "repo-a", [cloneB]: "repo-b" }),
      resolve: spy.resolve,
      git: gitAs({
        origin: "https://github.com/simpsonm09/repo-b.git",
        defaultBranch: "main",
        branches: ["feat/x"],
      }),
      env: [],
    },
  );
  assert.equal(spy.calls[0].repo, "repo-b");
  assert.equal(
    spy.calls[0].observation.commandDirectory,
    resolve(cwdA, "../repo-b"),
  );
  assert.equal(decision.action, "pass");
});

test("a push through -C to the clone's default branch is still denied", () => {
  const spy = resolver({
    code: 1,
    stdout: JSON.stringify({
      level: "propose",
      kind: "org",
      capability: "pushMain",
      allowed: false,
    }),
  });
  const decision = decideShell(
    { command: `git -C "${cloneB}" push origin main` },
    {
      cwd: cwdA,
      lookup: lookupFor({ [cwdA]: "repo-a", [cloneB]: "repo-b" }),
      resolve: spy.resolve,
      git: gitAs({
        origin: "https://github.com/simpsonm09/repo-b.git",
        defaultBranch: "main",
        branches: ["main", "feat/x"],
      }),
      env: [],
    },
  );
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].repo, "repo-b");
  assert.equal(spy.calls[0].observation.capability, "pushMain");
  assert.equal(decision.action, "deny");
  assert.equal(decision.repo, "repo-b");
  assert.match(
    decision.reason ?? "",
    /repo-b denies this command at level "propose"/,
  );
});

test("a -C outside the fleet denies a governed write instead of passing it", () => {
  const spy = resolver({
    code: 0,
    stdout: JSON.stringify({ level: "propose", kind: "org" }),
  });
  const decision = decideShell(
    { command: `git -C "${outside}" push origin feat/x` },
    {
      cwd: cwdA,
      lookup: lookupFor({ [cwdA]: "repo-a" }),
      resolve: spy.resolve,
      git: gitAs({
        origin: "https://github.com/simpsonm09/somewhere.git",
        defaultBranch: "main",
        branches: ["feat/x"],
      }),
      env: [],
    },
  );
  assert.equal(decision.action, "deny");
  assert.equal(decision.repo, null);
  assert.match(decision.reason ?? "", /git -C/);
  assert.match(decision.reason ?? "", /fleet repository/);
  assert.equal(spy.calls.length, 0);
});

test("a push without -C keeps the cwd's repository", () => {
  const spy = resolver({
    code: 0,
    stdout: JSON.stringify({
      level: "propose",
      kind: "org",
      auth: { route: "ambient", owner: null, repo: null },
    }),
  });
  const decision = decideShell(
    { command: "git push origin feat/x" },
    {
      cwd: cwdA,
      lookup: lookupFor({ [cwdA]: "repo-a", [cloneB]: "repo-b" }),
      resolve: spy.resolve,
      git: gitAs({
        origin: "https://github.com/simpsonm09/repo-a.git",
        defaultBranch: "main",
        branches: ["feat/x"],
      }),
      env: [],
    },
  );
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].repo, "repo-a");
  assert.equal(spy.calls[0].observation.commandDirectory, null);
  assert.deepEqual(
    observationDestination(spy.calls[0].observation),
    { host: "github.com", destination: "simpsonm09/repo-a" },
  );
  assert.equal(decision.action, "pass");
  assert.equal(decision.repo, "repo-a");
});

test("a directory outside the fleet with no -C passes without the resolver", () => {
  const spy = resolver({ code: 0, stdout: JSON.stringify({ level: "read" }) });
  const decision = decideShell(
    { command: "git push origin main" },
    {
      cwd: outside,
      lookup: lookupFor({}),
      resolve: spy.resolve,
      git: () => null,
      env: [],
    },
  );
  assert.equal(decision.action, "pass");
  assert.equal(decision.repo, null);
  assert.equal(spy.calls.length, 0);
});

test("the command directory is the one git's own -C reading reaches", () => {
  const directory = (command: string, cwd?: string) =>
    observeCommand(command, {
      cwd: cwd ?? ws,
      git: () => null,
    }).commandDirectory;
  assert.equal(directory("git push origin main"), null);
  assert.equal(directory("git -C sub push origin main"), resolve(ws, "sub"));
  assert.equal(
    directory("git -C a -C ../b push origin main"),
    resolve(resolve(ws, "a"), "../b"),
  );
  assert.equal(
    directory(`git -C "${cloneB}" -C inner push origin main`),
    resolve(cloneB, "inner"),
  );
  // A relative -C with no directory to read it against stays unresolved, which the gate
  // answers exactly as it answers the command without it.
  assert.equal(directory("git -C sub push origin main", ""), null);
  assert.equal(commandDirectory(["-C", "sub"], null), null);
});
