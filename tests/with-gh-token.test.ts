// The launcher (bin/with-gh-token.mjs) runs an allowed gh command with a token. It must trust
// only the workspace its own file sits in, verify the payload's hints, and re-run the decision
// itself. These tests plant a workspace and set the environment variables an attacker would
// use, and check that neither chooses the resolver, the broker, or the repository.
//
// Every test runs with PATH set to a stub directory (tests/support/stub-path.mjs), so a real
// gh or git on the machine is never reached from here.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { decodePayload, encodePayload } from "../bin/payload.mjs";
import { launch, trustedWorkspace } from "../bin/with-gh-token.mjs";
import { gitBashPath } from "../lib/bash.mjs";
import {
  buildWorkspace,
  removeDir,
  tempDir,
  writeCatalog,
} from "./support/fixture-workspace.mjs";
import { findOnPath, makeStubDir } from "./support/stub-path.mjs";

let ws = "";
let planted = "";
let stubDir = "";
let emptyDir = "";
let savedPath = "";
let bashPath: string | null = null;

before(() => {
  // Everything the tests need from the machine is looked up before PATH is restricted.
  savedPath = process.env.PATH ?? "";
  bashPath = gitBashPath({ ...process.env }, process.platform);
  const bash = findOnPath("bash", savedPath);

  ws = tempDir("launcher-ws-");
  buildWorkspace(ws, { level: "read" });

  // A planted workspace: its own resolver says everything is allowed, and its own catalog
  // says full. A launcher that trusted it would run a merge.
  planted = tempDir("launcher-planted-");
  const standard = join(
    planted,
    "projects",
    "repos",
    "simpsonm09-repo-standard",
    "scripts",
  );
  mkdirSync(standard, { recursive: true });
  writeFileSync(
    join(standard, "agent-access.mjs"),
    `export const loadCatalog = () => ({});\nexport const loadCommittedCatalog = () => null;\nexport const resolveLevel = () => ({ level: "full" });\nexport const decide = () => ({ capability: null, allowed: true });\n`,
  );
  mkdirSync(join(planted, "projects", "repos", "demo-repo"), {
    recursive: true,
  });

  stubDir = makeStubDir({ bash });
  emptyDir = makeStubDir({ withGh: false, bash });
  process.env.PATH = stubDir;
});

after(() => {
  process.env.PATH = savedPath;
  for (const dir of [ws, planted, stubDir, emptyDir]) if (dir) removeDir(dir);
});

function fleetCwd(root: string, rel = "projects/repos/demo-repo") {
  return join(root, ...rel.split("/"));
}

async function refused(
  payload: { workspace: string; repo: string; command: string },
  options: Record<string, unknown>,
) {
  const logs: string[] = [];
  const code = await launch(payload, {
    ...options,
    log: (message: string) => logs.push(message),
  } as never);
  return { code, logs };
}

test("the launcher refuses a payload that names another workspace", async () => {
  const result = await refused(
    { workspace: planted, repo: "demo-repo", command: "gh pr view 1" },
    { workspaceRoot: ws, cwd: fleetCwd(ws), env: {} },
  );
  assert.equal(result.code, 1);
  assert.match(result.logs.join("\n"), /different workspace/);
});

test("an environment override cannot choose the workspace or the resolver", async () => {
  // The planted resolver would allow a merge. The launcher must ignore SIMPSONM09_WORKSPACE
  // and the working directory, decide with its own resolver at level read, and refuse.
  const result = await refused(
    { workspace: ws, repo: "demo-repo", command: "gh pr merge 1" },
    {
      workspaceRoot: ws,
      cwd: fleetCwd(planted),
      env: { SIMPSONM09_WORKSPACE: planted },
    },
  );
  assert.equal(result.code, 1);
  assert.match(result.logs.join("\n"), /denied|could not|only an allowed/);
});

test("a planted workspace under the working directory is not a fleet repository", async () => {
  const result = await refused(
    { workspace: ws, repo: "demo-repo", command: "gh pr view 1" },
    { workspaceRoot: ws, cwd: fleetCwd(planted), env: {} },
  );
  assert.equal(result.code, 1);
});

test("the launcher refuses a payload whose repository is not the working directory's", async () => {
  const result = await refused(
    { workspace: ws, repo: "fork-repo", command: "gh pr view 1" },
    { workspaceRoot: ws, cwd: fleetCwd(ws), env: {} },
  );
  assert.equal(result.code, 1);
});

test("the launcher refuses a command that is not an allowed gh call", async () => {
  const result = await refused(
    { workspace: ws, repo: "demo-repo", command: "npm test" },
    { workspaceRoot: ws, cwd: fleetCwd(ws), env: {} },
  );
  assert.equal(result.code, 1);
  assert.match(result.logs.join("\n"), /only an allowed gh command/);
});

test("the launcher refuses a gh write the level denies, and runs nothing", async () => {
  const result = await refused(
    { workspace: ws, repo: "demo-repo", command: "gh pr merge 1" },
    { workspaceRoot: ws, cwd: fleetCwd(ws), env: {} },
  );
  assert.equal(result.code, 1);
  assert.match(result.logs.join("\n"), /denies this command at level "read"/);
});

test("on Windows the launcher refuses when the configured Git Bash is missing, rather than using bare bash", async () => {
  writeCatalog(ws, "read");
  const missing = join(ws, "no-such-bash.exe");
  const result = await refused(
    { workspace: ws, repo: "demo-repo", command: "gh pr view 1" },
    {
      workspaceRoot: ws,
      cwd: fleetCwd(ws),
      env: { CLAUDE_CODE_GIT_BASH_PATH: missing },
      platform: "win32",
    },
  );
  assert.equal(result.code, 1);
  assert.match(result.logs.join("\n"), /Git Bash was not found/);
});

test("an allowed gh read runs in bash with the token only in the child environment", async (t) => {
  if (!bashPath) return t.skip("no Git Bash on this machine");
  writeCatalog(ws, "read");
  const before = process.env.GH_TOKEN;
  const code = await launch(
    { workspace: ws, repo: "demo-repo", command: "gh pr view 1" },
    {
      workspaceRoot: ws,
      cwd: fleetCwd(ws),
      env: {
        ...process.env,
        PATH: stubDir,
        CLAUDE_CODE_GIT_BASH_PATH: bashPath,
      },
      log: () => {},
    },
  );
  assert.equal(code, 0, "the fake gh saw the fixture token in its environment");
  assert.equal(
    process.env.GH_TOKEN,
    before,
    "the token is not set in this process",
  );
});

test("an allowed gh.exe read runs in bash with the token, as the plain gh read does", async (t) => {
  if (!bashPath) return t.skip("no Git Bash on this machine");
  writeCatalog(ws, "read");
  const code = await launch(
    { workspace: ws, repo: "demo-repo", command: "gh.exe pr view 1" },
    {
      workspaceRoot: ws,
      cwd: fleetCwd(ws),
      env: {
        ...process.env,
        PATH: stubDir,
        CLAUDE_CODE_GIT_BASH_PATH: bashPath,
      },
      log: () => {},
    },
  );
  assert.equal(code, 0, "the fake gh.exe saw the fixture token");
});

test("the launcher refuses a gh.exe write the level denies, with the same reason as gh", async () => {
  const result = await refused(
    { workspace: ws, repo: "demo-repo", command: "gh.exe pr merge 1" },
    { workspaceRoot: ws, cwd: fleetCwd(ws), env: {} },
  );
  assert.equal(result.code, 1);
  assert.match(result.logs.join("\n"), /denies this command at level "read"/);
});

test("with no gh on the stub PATH the child fails loudly rather than finding a real binary", async (t) => {
  if (!bashPath) return t.skip("no Git Bash on this machine");
  writeCatalog(ws, "read");
  const code = await launch(
    { workspace: ws, repo: "demo-repo", command: "gh pr view 1" },
    {
      workspaceRoot: ws,
      cwd: fleetCwd(ws),
      env: {
        ...process.env,
        PATH: emptyDir,
        CLAUDE_CODE_GIT_BASH_PATH: bashPath,
      },
      log: () => {},
    },
  );
  assert.notEqual(code, 0, "a missing stub is a failure, not a success");
});

test("the launcher decodes only a well-formed payload", () => {
  const payload = {
    workspace: "C:\\ws",
    repo: "demo-repo",
    command: "gh pr view 1",
  };
  assert.deepEqual(decodePayload(encodePayload(payload)), payload);
  assert.throws(() => decodePayload("not base64 !!"));
  assert.throws(() =>
    decodePayload(
      Buffer.from(
        JSON.stringify({ workspace: "x", repo: "../evil", command: "gh" }),
      ).toString("base64"),
    ),
  );
});

test("the trusted workspace is the injected root in tests, and nothing else chooses it", () => {
  assert.equal(trustedWorkspace({ workspaceRoot: ws }), ws);
  assert.equal(trustedWorkspace({ workspaceRoot: "" }) === ws, false);
});
