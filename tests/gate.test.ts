import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  classifyResolver,
  contextLine,
  denyCommand,
  gateShellEdit,
  isPowerShell,
  isWriteCommand,
  nodeRunner,
  parseResolverOutput,
  powerShellQuote,
  pushRemote,
  remoteUrlFor,
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

test("pushRemote reads the remote after git push, defaulting to origin", () => {
  assert.equal(pushRemote("git push"), "origin");
  assert.equal(pushRemote("git push origin main"), "origin");
  assert.equal(pushRemote("git push upstream main"), "upstream");
  assert.equal(pushRemote("git push --dry-run origin main"), "origin");
  assert.equal(pushRemote("git push -f upstream refs/heads/main"), "upstream");
  assert.equal(pushRemote("git push --force-with-lease"), "origin");
  // A bare "main" in the remote position reads as a remote, matching the
  // resolver's own parse: it has no colon and no slash, so it is not a refspec.
  assert.equal(pushRemote("git push main"), "main");
  assert.equal(pushRemote("git push refs/heads/main"), "origin");
  assert.equal(pushRemote("git push feat/x:main"), "origin");
  // Not a git push: no remote to resolve.
  assert.equal(pushRemote("gh pr merge 1"), null);
  assert.equal(pushRemote("git fetch origin"), null);
  assert.equal(pushRemote("ls -la"), null);
});

test("remoteUrlFor returns the trimmed URL and null on any failure", () => {
  const ok = () =>
    remoteUrlFor(
      "origin",
      "/repo",
      () => "https://github.com/simpsonm09/simpsonm09-repo-standard.git\n",
    );
  assert.equal(
    ok(),
    "https://github.com/simpsonm09/simpsonm09-repo-standard.git",
  );

  const seen: string[][] = [];
  remoteUrlFor("upstream", "/repo", (args) => {
    seen.push(args);
    return "https://github.com/simpsonm09-org/x.git";
  });
  assert.deepEqual(seen, [["-C", "/repo", "remote", "get-url", "upstream"]]);

  const throws = () =>
    remoteUrlFor("origin", "/repo", () => {
      throw new Error("no such remote");
    });
  assert.equal(throws(), null);
  assert.equal(
    remoteUrlFor("origin", "/repo", () => "  \n"),
    null,
  );
  assert.equal(
    remoteUrlFor("", "/repo", () => "x"),
    null,
  );
  assert.equal(
    remoteUrlFor("origin", "", () => "x"),
    null,
  );
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

test("denyCommand prints to stderr and exits non-zero in POSIX form", () => {
  const command = denyCommand("repo is read-only");
  assert.match(command, />&2/);
  assert.match(command, /exit 1/);
  assert.match(command, /agent-access: denied: repo is read-only/);
});

test("denyCommand quotes a reason that contains a single quote in POSIX form", () => {
  const command = denyCommand("it's locked");
  assert.match(command, /'agent-access: denied: it'\\''s locked'/);
});

test("denyCommand uses PowerShell syntax for a PowerShell shell", () => {
  const command = denyCommand("repo is read-only", "pwsh");
  assert.match(command, /^Write-Error '/);
  assert.match(command, /; exit 1$/);
  assert.match(command, /agent-access: denied: repo is read-only/);
  assert.doesNotMatch(command, />&2/);
});

test("denyCommand doubles an embedded single quote in PowerShell form", () => {
  const command = denyCommand("it's locked", "powershell");
  assert.match(
    command,
    /Write-Error 'agent-access: denied: it''s locked'; exit 1/,
  );
});

test("denyCommand keeps the POSIX form for an unknown shell", () => {
  const command = denyCommand("nope", "bash");
  assert.match(command, />&2/);
  assert.match(command, /agent-access: denied: nope/);
});

test("isPowerShell matches the PowerShell family only", () => {
  assert.equal(isPowerShell("pwsh"), true);
  assert.equal(isPowerShell("powershell"), true);
  assert.equal(isPowerShell("PowerShell.exe"), true);
  assert.equal(isPowerShell("pwsh.exe"), true);
  assert.equal(
    isPowerShell(
      "C:/Program Files/WindowsApps/Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe/pwsh.EXE",
    ),
    true,
  );
  assert.equal(
    isPowerShell("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"),
    true,
  );
  assert.equal(isPowerShell("bash"), false);
  assert.equal(isPowerShell("/bin/sh"), false);
  assert.equal(isPowerShell(""), false);
});

test("powerShellQuote doubles embedded single quotes", () => {
  assert.equal(powerShellQuote("plain"), "'plain'");
  assert.equal(powerShellQuote("it's"), "'it''s'");
});

test("nodeRunner never returns the OpenCode binary", () => {
  assert.equal(
    nodeRunner("C:/Users/x/AppData/Local/Programs/opencode-cli/opencode.exe"),
    "node",
  );
  assert.equal(
    nodeRunner("C:/Program Files/nodejs/node.exe"),
    "C:/Program Files/nodejs/node.exe",
  );
  assert.equal(nodeRunner("/usr/local/bin/node"), "/usr/local/bin/node");
  assert.equal(nodeRunner("/usr/local/bin/bun"), "/usr/local/bin/bun");
  assert.equal(nodeRunner(""), "node");
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
  resolve: (
    repo: string,
    command: string,
    remoteUrl: string | null,
  ) => { code: number; stdout: string },
) => ({
  cwd: insideRepo,
  workspaceRoot: ws,
  resolve,
  remoteUrl: () => "https://github.com/simpsonm09-org/demo-repo.git",
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

test("gateShellEdit rewrites a denied command into the failing POSIX form", async () => {
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

test("gateShellEdit rewrites a denied command into PowerShell form when the shell is pwsh", async () => {
  const input = { command: "gh pr merge 1", shell: "pwsh" };
  const env: Record<string, string | undefined> = {};
  const decision = await gateShellEdit(
    input,
    env,
    stubDeps(() => ({ code: 1, stdout: jsonFor("read") })),
  );

  assert.equal(decision.action, "deny");
  assert.match(input.command, /Write-Error '/);
  assert.match(input.command, /; exit 1$/);
  assert.doesNotMatch(input.command, />&2/);
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

// A scope-aware resolver stub that mirrors the real resolver: a git push to a
// known non-organization URL needs no capability and is allowed; every other
// push against the organization (or an unknown) URL is governed. The gate must
// resolve the remote and hand the URL to this resolver for the fork push to
// pass and the organization main push to fail.
const scopedResolver =
  (level: string) =>
  (_repo: string, command: string, remoteUrl: string | null) => {
    const url = remoteUrl ?? "";
    const isPush = /(^|\s)git push(\s|$)/.test(command);
    const outOfScope =
      isPush && url.length > 0 && !url.includes("simpsonm09-org");
    const wantsMain = /\bmain\b/.test(command);
    const allowed = outOfScope || !wantsMain || level === "full";
    return {
      code: allowed ? 0 : 1,
      stdout: JSON.stringify({ level, capability: null, allowed }),
    };
  };

test("gateShellEdit passes the fork remote URL and allows a fork push", async () => {
  const seen: Array<[string, string | null]> = [];
  const input = { command: "git push --dry-run origin main" };
  const env: Record<string, string | undefined> = {};
  const decision = await gateShellEdit(input, env, {
    ...stubDeps((_repo, command, remoteUrl) => {
      seen.push([command, remoteUrl]);
      return scopedResolver("propose")(_repo, command, remoteUrl);
    }),
    remoteUrl: () =>
      "https://github.com/simpsonm09/simpsonm09-repo-standard.git",
  });

  assert.deepEqual(seen, [
    [
      "git push --dry-run origin main",
      "https://github.com/simpsonm09/simpsonm09-repo-standard.git",
    ],
  ]);
  assert.equal(decision.action, "pass");
  assert.equal(decision.level, "propose");
  assert.equal(input.command, "git push --dry-run origin main");
});

test("gateShellEdit passes the organization remote URL and denies an org main push", async () => {
  const seen: string[] = [];
  const input = { command: "git push --dry-run upstream main" };
  const env: Record<string, string | undefined> = {};
  const decision = await gateShellEdit(input, env, {
    ...stubDeps((_repo, command, remoteUrl) => {
      seen.push(remoteUrl ?? "");
      return scopedResolver("propose")(_repo, command, remoteUrl);
    }),
    remoteUrl: () =>
      "https://github.com/simpsonm09-org/simpsonm09-repo-standard.git",
  });

  assert.deepEqual(seen, [
    "https://github.com/simpsonm09-org/simpsonm09-repo-standard.git",
  ]);
  assert.equal(decision.action, "deny");
  assert.match(input.command, /exit 1/);
});

test("gateShellEdit passes no URL when git cannot resolve the remote", async () => {
  const seen: Array<string | null> = [];
  const input = { command: "git push origin main" };
  const env: Record<string, string | undefined> = {};
  const decision = await gateShellEdit(input, env, {
    ...stubDeps((_repo, command, remoteUrl) => {
      seen.push(remoteUrl);
      return scopedResolver("propose")(_repo, command, remoteUrl);
    }),
    remoteUrl: () => null,
  });

  assert.deepEqual(seen, [null]);
  assert.equal(decision.action, "deny");
});

test("gateShellEdit skips the remote lookup for a non-push command", async () => {
  let lookups = 0;
  const input = { command: "gh pr list" };
  const env: Record<string, string | undefined> = {};
  const decision = await gateShellEdit(input, env, {
    ...stubDeps(() => ({ code: 0, stdout: jsonFor("propose") })),
    remoteUrl: () => {
      lookups += 1;
      return null;
    },
  });

  assert.equal(decision.action, "inject");
  assert.equal(lookups, 0);
});
