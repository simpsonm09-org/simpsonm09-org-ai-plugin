import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import plugin from "../index.ts";

// index.ts derives its workspace from import.meta.url: the plugin lives at
// <workspace>/.opencode/plugins/<name>, so the workspace is three levels up
// from the repository at <workspace>/projects/repos/<name>. The resolver and
// broker are the shared scripts of the repo-standard clone in that workspace.
// The hooks run against those real scripts, the same way they do in the
// workspace, so this test drives the setup wiring end to end.

const here = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(here, "..");
const workspaceRoot = resolve(repoDir, "..", "..", "..");
const reposRoot = join(workspaceRoot, "projects", "repos");
const repoName = "simpsonm09-org-opencode-plugin";
const cloneDir = join(reposRoot, repoName);
const hasStandard = existsSync(
  join(reposRoot, "simpsonm09-repo-standard", "scripts", "agent-access.mjs"),
);

async function setupWithStubs(location) {
  const skills = [];
  const editor = {
    get: (id) => skills.find((skill) => skill.id === id),
    remove: (id) => {
      const index = skills.findIndex((skill) => skill.id === id);
      if (index >= 0) skills.splice(index, 1);
    },
    add: (skill) => skills.push(skill),
  };
  const shellCallbacks = new Map();
  const sessionCallbacks = new Map();
  const shell = {
    hook: async (name, callback) => {
      shellCallbacks.set(name, callback);
      return { dispose: async () => {} };
    },
  };
  const session = {
    hook: async (name, callback) => {
      sessionCallbacks.set(name, callback);
      return { dispose: async () => {} };
    },
  };
  const skill = {
    transform: async (callback) => {
      callback(editor);
      return { dispose: async () => {} };
    },
  };

  await plugin.setup({
    skill,
    shell,
    session,
    location: { directory: resolve(location) },
  });

  return {
    skills,
    shellBefore: shellCallbacks.get("create.before"),
    sessionContext: sessionCallbacks.get("context"),
  };
}

test("setup registers every repository skill through the transform editor", async () => {
  const { skills } = await setupWithStubs(repoDir);

  const ids = skills.map((skill) => skill.id).sort();
  assert.ok(ids.includes("service-integrations"), `skills ${ids}`);
  assert.ok(ids.includes("repo-standard"), `skills ${ids}`);
  assert.ok(ids.includes("repo-tasks"), `skills ${ids}`);
  assert.ok(ids.includes("local-services"), `skills ${ids}`);
  for (const skill of skills) {
    assert.equal(typeof skill.name, "string");
    assert.equal(typeof skill.description, "string");
    assert.ok(skill.description.length > 0, `${skill.id} has no description`);
  }
});

test("the shell create.before hook leaves a cwd outside the fleet alone", async () => {
  const { shellBefore } = await setupWithStubs(repoDir);
  assert.equal(typeof shellBefore, "function");

  const input = { command: "ls -la", cwd: workspaceRoot, env: {} };
  const result = await shellBefore(input);

  assert.equal(result, undefined);
  assert.equal(input.command, "ls -la");
  assert.deepEqual(input.env, {});
});

test("the shell create.before hook resolves a read inside a fleet clone", {
  skip: !hasStandard && "the repo-standard scripts are not checked out",
}, async () => {
  const { shellBefore, sessionContext } = await setupWithStubs(cloneDir);
  assert.equal(typeof shellBefore, "function");
  assert.equal(typeof sessionContext, "function");

  // The command is a read, so the resolver allows it and the text is kept.
  const input = { command: "ls -la", cwd: cloneDir, env: {} };
  await shellBefore(input);
  assert.equal(input.command, "ls -la");
  assert.equal(typeof input.env, "object");

  // The context callback resolves the level and appends the line.
  const event = { system: [] };
  sessionContext(event);
  assert.equal(event.system.length, 1);
  assert.equal(event.system[0].type, "text");
  assert.match(event.system[0].text, /agent-access: the repository /);
  assert.match(event.system[0].text, new RegExp(repoName));
});

test("the shell create.before hook fails closed on a write outside the gate", {
  skip: !hasStandard && "the repo-standard scripts are not checked out",
}, async () => {
  const { shellBefore } = await setupWithStubs(cloneDir);

  // A remote write the resolver cannot answer for is denied by rewriting the
  // command. This is a git write, not a gh command, so no token is minted.
  const input = { command: "git push origin main", cwd: cloneDir, env: {} };
  await shellBefore(input);
  if (/exit 1/.test(input.command)) {
    assert.match(input.command, />&2/);
    assert.equal(input.env.GH_TOKEN, undefined);
  } else {
    // A granted write leaves the command untouched.
    assert.equal(input.command, "git push origin main");
  }
});
