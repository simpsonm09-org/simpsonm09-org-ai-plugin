import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import plugin from "../index.ts";

// index.ts derives the workspace from import.meta.url, so the resolver and
// broker default to the repo-standard clone beside this repository. A caller
// can point them elsewhere with options.scripts; the tests below use a fixture
// so the setup wiring runs in any checkout, workspace or not.

const here = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(here, "..");
const workspaceRoot = resolve(repoDir, "..", "..", "..");
const reposRoot = join(workspaceRoot, "projects", "repos");

// The cwd must resolve to a fleet clone, but the clone directory does not have
// to exist for repoFromCwd, so a path under projects/repos works without a
// workspace. The script paths come from the fixture, never the environment.
const fleetCwd = join(reposRoot, "demo-repo");

// A resolver that reports the level and capability for the command, and a
// broker that mints a fixed token. Both write one JSON object, matching the
// frozen interface. The token is a literal, never a real credential.
const ACCESS_SCRIPT = `#!/usr/bin/env node
const args = process.argv.slice(2);
const json = args.includes("--json");
const hasCommand = args.includes("--command");
if (hasCommand) {
  process.stdout.write(JSON.stringify({ level: "propose", capability: "read", allowed: true }));
} else if (json) {
  process.stdout.write(JSON.stringify({ level: "propose" }));
} else {
  process.exit(2);
}
`;

const TOKEN_SCRIPT = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ token: "ghs_fixture", expires_at: "2099-01-01T00:00:00Z" }));
`;

function fixtureScripts() {
  const dir = mkdtempSync(join(tmpdir(), "org-scripts-"));
  const access = join(dir, "agent-access.mjs");
  const token = join(dir, "agent-token.mjs");
  writeFileSync(access, ACCESS_SCRIPT);
  writeFileSync(token, TOKEN_SCRIPT);
  return { dir, access, token };
}

async function setupWithStubs({ location, scripts } = {}) {
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
    location: { directory: resolve(location ?? repoDir) },
    ...(scripts ? { options: { scripts } } : {}),
  });

  return {
    skills,
    shellBefore: shellCallbacks.get("create.before"),
    sessionContext: sessionCallbacks.get("context"),
  };
}

async function withFixture(body) {
  const scripts = fixtureScripts();
  try {
    await body(scripts);
  } finally {
    rmSync(scripts.dir, { recursive: true, force: true });
  }
}

test("setup registers every repository skill through the transform editor", async () => {
  const { skills } = await setupWithStubs();

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
  const { shellBefore } = await setupWithStubs();
  assert.equal(typeof shellBefore, "function");

  const input = { command: "ls -la", cwd: workspaceRoot, env: {} };
  const result = await shellBefore(input);

  assert.equal(result, undefined);
  assert.equal(input.command, "ls -la");
  assert.deepEqual(input.env, {});
});

test("setup leaves the resolver unknown when the scripts are absent", async () => {
  const missing = join(tmpdir(), "org-scripts-absent-xyz");
  const { shellBefore, sessionContext } = await setupWithStubs({
    location: fleetCwd,
    scripts: {
      access: join(missing, "agent-access.mjs"),
      token: join(missing, "agent-token.mjs"),
    },
  });

  // A gh command is a write, so an unknown resolver fails closed.
  const ghInput = { command: "gh pr merge 3", cwd: fleetCwd, env: {} };
  await shellBefore(ghInput);
  assert.match(ghInput.command, />&2/);
  assert.match(ghInput.command, /exit 1/);
  assert.equal(ghInput.env.GH_TOKEN, undefined);

  // A read passes untouched, and the level falls back to read.
  const readInput = { command: "ls -la", cwd: fleetCwd, env: {} };
  await shellBefore(readInput);
  assert.equal(readInput.command, "ls -la");

  const event = { system: [] };
  sessionContext(event);
  assert.equal(event.system.length, 1);
  assert.match(event.system[0].text, /"read"/);
});

test("the shell create.before hook fails closed when the broker cannot mint", async () => {
  await withFixture(async (scripts) => {
    const { shellBefore } = await setupWithStubs({
      location: fleetCwd,
      scripts: {
        access: scripts.access,
        token: join(scripts.dir, "absent.mjs"),
      },
    });

    const input = { command: "gh pr create --fill", cwd: fleetCwd, env: {} };
    await shellBefore(input);

    assert.match(input.command, />&2/);
    assert.match(input.command, /exit 1/);
    assert.equal(input.env.GH_TOKEN, undefined);
  });
});

test("the shell create.before hook injects a token for an allowed gh command", async () => {
  await withFixture(async (scripts) => {
    const { shellBefore } = await setupWithStubs({
      location: fleetCwd,
      scripts,
    });

    const input = { command: "gh pr list", cwd: fleetCwd, env: {} };
    await shellBefore(input);

    assert.equal(input.command, "gh pr list");
    assert.equal(typeof input.env.GH_TOKEN, "string");
    assert.equal(input.env.GH_TOKEN, "ghs_fixture");
  });
});

test("the context callback appends the resolved level for a fleet clone", async () => {
  await withFixture(async (scripts) => {
    const { sessionContext } = await setupWithStubs({
      location: fleetCwd,
      scripts,
    });

    const event = { system: [] };
    sessionContext(event);

    assert.equal(event.system.length, 1);
    assert.equal(event.system[0].type, "text");
    assert.match(
      event.system[0].text,
      /agent-access: the repository demo-repo /,
    );
    assert.match(event.system[0].text, /"propose"/);
  });
});

test("the context callback leaves a cwd outside the fleet alone", async () => {
  const { sessionContext } = await setupWithStubs({ location: workspaceRoot });
  const event = { system: [] };
  sessionContext(event);
  assert.deepEqual(event.system, []);
});
