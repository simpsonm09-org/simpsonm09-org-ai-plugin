import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  classifyResolver,
  contextLine,
  denyCommand,
  gateShellEdit,
  isWriteCommand,
  parseResolverOutput,
  repoFromCwd,
  shouldInject,
  tokenUsable,
} from "../gate.mjs";

const ws = resolve("workspace");
const reposRoot = join(ws, "projects", "repos");

test("repoFromCwd names the clone for a directory inside a repo", () => {
  assert.equal(
    repoFromCwd(join(reposRoot, "simpsonm09-org-opencode-plugin"), ws),
    "simpsonm09-org-opencode-plugin",
  );
  assert.equal(
    repoFromCwd(
      join(reposRoot, "simpsonm09-org-opencode-plugin", "src", "deep"),
      ws,
    ),
    "simpsonm09-org-opencode-plugin",
  );
});

test("repoFromCwd returns null outside projects/repos", () => {
  assert.equal(repoFromCwd(join(ws, "projects"), ws), null);
  assert.equal(repoFromCwd(ws, ws), null);
  assert.equal(repoFromCwd(reposRoot, ws), null);
  assert.equal(
    repoFromCwd(join(ws, "..", "elsewhere", "projects", "repos", "x"), ws),
    null,
  );
  assert.equal(repoFromCwd("", ws), null);
  assert.equal(repoFromCwd(reposRoot, ""), null);
});

test("shouldInject only matches a gh command", () => {
  assert.equal(shouldInject("gh pr create"), true);
  assert.equal(shouldInject("gh"), true);
  assert.equal(shouldInject("  gh pr list"), false);
  assert.equal(shouldInject("git status"), false);
  assert.equal(shouldInject("npx gh"), false);
});

test("classifyResolver maps exit codes to allow, deny, and unknown", () => {
  assert.equal(classifyResolver({ code: 0, stdout: "read\n" }), "allow");
  assert.equal(classifyResolver({ code: 1, stdout: "" }), "deny");
  assert.equal(classifyResolver({ code: 2, stdout: "" }), "unknown");
  assert.equal(classifyResolver({ code: 127, stdout: "" }), "unknown");
});

test("isWriteCommand recognizes a gh command and a remote write", () => {
  assert.equal(isWriteCommand("gh api -X POST /repos"), true);
  assert.equal(isWriteCommand("git push origin main"), true);
  assert.equal(isWriteCommand("gh pr merge 3"), true);
  assert.equal(isWriteCommand("ls -la"), false);
  assert.equal(isWriteCommand("cat file"), false);
});

test("denyCommand prints to stderr and exits non-zero", () => {
  const command = denyCommand("repo is read-only");
  assert.match(command, />&2/);
  assert.match(command, /exit 1/);
  assert.match(command, /agent-access: denied: repo is read-only/);
});

test("denyCommand quotes a reason that contains a single quote", () => {
  const command = denyCommand("it's locked");
  assert.match(command, /'agent-access: denied: it'\\''s locked'/);
});

test("tokenUsable rejects an absent, malformed, or expiring cache", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(tokenUsable(null, now), false);
  assert.equal(
    tokenUsable({ token: "", expires_at: "2026-01-01T00:10:00Z" }, now),
    false,
  );
  assert.equal(
    tokenUsable({ token: "x", expires_at: "not-a-date" }, now),
    false,
  );
  assert.equal(
    tokenUsable({ token: "x", expires_at: "2026-01-01T00:02:00Z" }, now),
    false,
  );
  assert.equal(
    tokenUsable({ token: "x", expires_at: "2026-01-01T01:00:00Z" }, now),
    true,
  );
});

test("contextLine names the repository and its level", () => {
  assert.match(
    contextLine("simpsonm09-org-opencode-plugin", "read"),
    /simpsonm09-org-opencode-plugin/,
  );
  assert.match(contextLine("simpsonm09-org-opencode-plugin", "read"), /"read"/);
});

test("parseResolverOutput reads the level and capability from the resolver JSON", () => {
  assert.deepEqual(
    parseResolverOutput(
      '{"level":"merge","capability":"mergePr","allowed":true}',
    ),
    {
      level: "merge",
      capability: "mergePr",
    },
  );
  assert.deepEqual(
    parseResolverOutput('{"level":"read","capability":null,"allowed":true}'),
    {
      level: "read",
      capability: null,
    },
  );
  assert.equal(parseResolverOutput(""), null);
  assert.equal(parseResolverOutput("read\n"), null);
  assert.equal(parseResolverOutput('{"capability":"x"}'), null);
});

const insideRepo = join(reposRoot, "demo-repo");
const outsideRepo = join(ws, "docs");
const stubDeps = (
  resolve: (repo: string, command: string) => { code: number; stdout: string },
) => ({
  cwd: insideRepo,
  workspaceRoot: ws,
  resolve,
  tokenFor: async () => "ghs_stub_token",
});
const jsonFor = (level: string) =>
  JSON.stringify({ level, capability: null, allowed: true });

test("gateShellEdit leaves a command outside a fleet clone alone", async () => {
  const input = { command: "git push" };
  const env: Record<string, string | undefined> = {};
  const decision = await gateShellEdit(input, env, {
    ...stubDeps(() => ({ code: 0, stdout: jsonFor("merge") })),
    cwd: outsideRepo,
  });

  assert.equal(decision.action, "pass");
  assert.equal(decision.repo, null);
  assert.equal(input.command, "git push");
  assert.equal(env.GH_TOKEN, undefined);
});

test("gateShellEdit rewrites a denied command into the failing form", async () => {
  const input = { command: "git push origin main" };
  const env: Record<string, string | undefined> = {};
  const decision = await gateShellEdit(
    input,
    env,
    stubDeps(() => ({ code: 1, stdout: jsonFor("read") })),
  );

  assert.equal(decision.action, "deny");
  assert.equal(decision.level, "read");
  assert.match(input.command, /exit 1/);
  assert.match(input.command, />&2/);
  assert.equal(env.GH_TOKEN, undefined);
});

test("gateShellEdit injects GH_TOKEN for an allowed gh command", async () => {
  const input = { command: "gh pr list" };
  const env: Record<string, string | undefined> = {};
  const decision = await gateShellEdit(
    input,
    env,
    stubDeps(() => ({ code: 0, stdout: jsonFor("propose") })),
  );

  assert.equal(decision.action, "inject");
  assert.equal(decision.level, "propose");
  assert.equal(env.GH_TOKEN, "ghs_stub_token");
  assert.equal(input.command, "gh pr list");
});

test("gateShellEdit fails closed on an unknown resolver for a write", async () => {
  const input = { command: "git push origin main" };
  const env: Record<string, string | undefined> = {};
  const decision = await gateShellEdit(
    input,
    env,
    stubDeps(() => ({ code: 2, stdout: "" })),
  );

  assert.equal(decision.action, "deny");
  assert.match(input.command, /exit 1/);
});

test("gateShellEdit passes an unknown resolver for a read", async () => {
  const input = { command: "ls -la" };
  const env: Record<string, string | undefined> = {};
  const decision = await gateShellEdit(
    input,
    env,
    stubDeps(() => ({ code: 2, stdout: "" })),
  );

  assert.equal(decision.action, "pass");
  assert.equal(input.command, "ls -la");
});

test("gateShellEdit fails closed when a gh command cannot mint a token", async () => {
  const input = { command: "gh pr create --fill" };
  const env: Record<string, string | undefined> = {};
  const decision = await gateShellEdit(input, env, {
    ...stubDeps(() => ({ code: 0, stdout: jsonFor("propose") })),
    tokenFor: async () => null,
  });

  assert.equal(decision.action, "deny");
  assert.match(input.command, /exit 1/);
  assert.equal(env.GH_TOKEN, undefined);
});
