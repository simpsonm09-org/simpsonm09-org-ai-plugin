import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultScripts } from "../access.mjs";
import plugin from "../index.ts";
import { buildWorkspace, tempDir } from "./support/fixture-workspace.mjs";

// The tests use a temporary workspace with a committed catalog and the package's real pinned
// resolver. Only the token broker is a fixture.

const here = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(here, "..");

// Every test runs under a temporary workspace root that this file creates and removes. The
// real workspace, its clones, and its sibling scripts are never read or written.
let workspaceRoot = "";
let reposRoot = "";
let fleetCwd = "";

before(() => {
  workspaceRoot = tempDir("org-index-ws-");
  buildWorkspace(workspaceRoot, { level: "propose" });
  reposRoot = join(workspaceRoot, "projects", "repos");
  fleetCwd = join(reposRoot, "demo-repo");
});

after(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
});

function tokenModuleSource(token = "fixture-token-not-real") {
  return `export async function mintForRepo(owner, repo) {
  return { token: ${JSON.stringify(token)}, expires_at: "2099-01-01T00:00:00Z" };
}
`;
}

function fixtureScripts({ token } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "org-scripts-"));
  const tokenPath = join(dir, "agent-token.mjs");
  writeFileSync(tokenPath, token ?? tokenModuleSource());
  return {
    dir,
    access: defaultScripts(workspaceRoot).access,
    token: tokenPath,
  };
}

// A missing resolver path is never replaced with another source.
function absentScripts() {
  return {
    access: join(workspaceRoot, "absent-agent-access.mjs"),
    token: join(workspaceRoot, "absent-agent-token.mjs"),
  };
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
    options: { workspaceRoot, scripts: scripts ?? absentScripts() },
  });

  return {
    skills,
    shellBefore: shellCallbacks.get("create.before"),
    sessionContext: sessionCallbacks.get("context"),
  };
}

async function withFixture(body, options) {
  const scripts = fixtureScripts(options);
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

test("the hook reports the module's real level, not the fallback, on a denial", async () => {
  await withFixture(async (scripts) => {
    const { shellBefore } = await setupWithStubs({
      location: fleetCwd,
      scripts,
    });

    // mergePr is denied at level "propose", so the level in the message must be
    // "propose", never the "read" fallback the live spawn bug produced.
    const input = { command: "gh pr merge 3", cwd: fleetCwd, env: {} };
    await shellBefore(input);

    assert.match(input.command, /denies this command at level "propose"/);
    assert.doesNotMatch(input.command, /level "read"/);
  });
});

test("the hook emits a PowerShell denial for a pwsh shell", async () => {
  await withFixture(async (scripts) => {
    const { shellBefore } = await setupWithStubs({
      location: fleetCwd,
      scripts,
    });

    const input = {
      command: "gh pr merge 3",
      cwd: fleetCwd,
      env: {},
      shell: "C:/Program Files/WindowsApps/PowerShell/pwsh.EXE",
    };
    await shellBefore(input);

    assert.match(input.command, /^Write-Error '/);
    assert.match(input.command, /; exit 1$/);
    assert.doesNotMatch(input.command, />&2/);
  });
});

test("the hook resolves through the packaged module and uses only the broker fixture", async () => {
  await withFixture(async (scripts) => {
    const { shellBefore } = await setupWithStubs({
      location: fleetCwd,
      scripts,
    });
    const input = { command: "gh pr list", cwd: fleetCwd, env: {} };
    await shellBefore(input);
    assert.equal(input.command, "gh pr list");
    assert.equal(input.env.GH_TOKEN, "fixture-token-not-real");
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
    assert.equal(input.env.GH_TOKEN, "fixture-token-not-real");
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

// A real git clone under projects/repos, so the plugin's git remote lookup runs
// for real. The remotes point at the fork and the organization, matching the
// workspace. Returns the directory and a teardown.
function realFleetClone(name: string, remotes: Record<string, string>) {
  const dir = join(reposRoot, name);
  rmSync(dir, { recursive: true, force: true });
  execFileSync("git", ["init", "-q", dir], { windowsHide: true });
  for (const [remote, url] of Object.entries(remotes)) {
    execFileSync("git", ["-C", dir, "remote", "add", remote, url], {
      windowsHide: true,
    });
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("an approved owned-fork branch push is allowed through the live plugin wiring", async () => {
  const ownedFork = join(reposRoot, "pstack-max");
  await withFixture(async (scripts) => {
    const { shellBefore } = await setupWithStubs({
      location: ownedFork,
      scripts,
    });

    const branch = {
      command: "git push --dry-run origin feat/x",
      cwd: ownedFork,
      env: {},
    };
    await shellBefore(branch);
    assert.equal(branch.command, "git push --dry-run origin feat/x");
    assert.doesNotMatch(branch.command, /exit 1/);

    // The same owned fork denies its default branch: the owned-fork grant is a branch push
    // and a same-repository pull request, never `main`.
    const main = {
      command: "git push --dry-run origin main",
      cwd: ownedFork,
      env: {},
    };
    await shellBefore(main);
    assert.match(main.command, /agent-access: denied/);
    assert.match(main.command, /simpsonm09\/pstack-max denies pushMain/);
  });
});

test("an organization main push is denied through the live plugin wiring at a propose repo", async () => {
  const clone = realFleetClone("u8-org-probe", {
    origin: "https://github.com/simpsonm09/simpsonm09-repo-standard.git",
    upstream: "https://github.com/simpsonm09-org/simpsonm09-repo-standard.git",
  });
  try {
    await withFixture(async (scripts) => {
      const { shellBefore } = await setupWithStubs({
        location: clone.dir,
        scripts,
      });

      const input = {
        command: "git push --dry-run upstream main",
        cwd: clone.dir,
        env: {},
      };
      await shellBefore(input);

      assert.match(input.command, /agent-access: denied/);
      assert.match(input.command, /exit 1/);
    });
  } finally {
    clone.cleanup();
  }
});

// A worktree directory is resolved through git. With git missing from PATH, the lookup cannot
// run, and the gate must answer the way it answers a command the resolver cannot decide: a
// write is denied, a read passes, and no context line is added. It must not throw.
test("with git missing from PATH, a write in a worktree is denied, a read passes, and no context line is added", async () => {
  const worktree = join(workspaceRoot, "projects", "worktrees", "wt-no-git");
  mkdirSync(worktree, { recursive: true });
  const emptyPath = mkdtempSync(join(tmpdir(), "org-empty-path-"));
  const savedPath = process.env.PATH;
  process.env.PATH = emptyPath;
  try {
    const { shellBefore, sessionContext } = await setupWithStubs({
      location: worktree,
    });

    const write = { command: "git push origin main", cwd: worktree, env: {} };
    await shellBefore(write);
    assert.match(
      write.command,
      /agent-access: denied: the working directory could not be resolved/,
    );
    assert.match(write.command, /exit 1/);

    const read = { command: "git status", cwd: worktree, env: {} };
    await shellBefore(read);
    assert.equal(read.command, "git status");

    const event = { system: [] as unknown[] };
    sessionContext(event);
    assert.deepEqual(event.system, []);
  } finally {
    process.env.PATH = savedPath;
    rmSync(emptyPath, { recursive: true, force: true });
  }
});
