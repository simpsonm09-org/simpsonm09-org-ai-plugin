import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultScripts, loadAccessApi, resolveAccess } from "../access.mjs";
import {
  hasPinnedAccessApi,
  hasSupportedPinMetadata,
  loadPinnedAccessApi,
  pinMetadata,
  RESOLVER_PIN,
} from "../lib/pinned-access.mjs";
import {
  buildWorkspace,
  removeDir,
  tempDir,
} from "./support/fixture-workspace.mjs";

const ORG_URL = "https://github.com/simpsonm09-org/demo-repo.git";
const FORK_URL = "https://github.com/simpsonm09/fork-repo.git";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the packaged resolver pin names the reviewed artifact and API contract", () => {
  assert.equal(
    RESOLVER_PIN.repository,
    "simpsonm09-org/simpsonm09-repo-standard",
  );
  assert.equal(RESOLVER_PIN.commit, "5da707371e38c6391df83d13b487a01253379457");
  assert.equal(RESOLVER_PIN.sourcePath, "scripts/agent-access.mjs");
  assert.match(RESOLVER_PIN.sha256, /^[0-9a-f]{64}$/);
  assert.equal(RESOLVER_PIN.apiVersion, 1);
  assert.equal(
    hasPinnedAccessApi({
      loadCommittedCatalog() {},
      resolveLevel() {},
      decide() {},
    }),
    true,
  );
  assert.equal(hasPinnedAccessApi({ resolveLevel() {}, decide() {} }), false);
  assert.equal(hasSupportedPinMetadata(pinMetadata()), true);
  assert.equal(
    hasSupportedPinMetadata({ ...pinMetadata(), apiVersion: 2 }),
    false,
  );
});

test("pin provenance in the readme and docs manifest matches the runtime", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const manifest = JSON.parse(
    readFileSync(join(root, "docs", "manifest.json"), "utf8"),
  );
  assert.ok(readme.includes(RESOLVER_PIN.commit));
  assert.ok(readme.includes(RESOLVER_PIN.sha256));
  assert.deepEqual(manifest.features, [
    "docs/features/pinned-gate-resolver.md",
  ]);
  assert.ok(existsSync(join(root, ...manifest.features[0].split("/"))));
});

test("missing or corrupt packaged resolver bytes cannot load an API", async () => {
  const dir = tempDir("pinned-resolver-corrupt-");
  try {
    const missing = join(dir, "missing.mjs");
    assert.equal(await loadPinnedAccessApi(missing), null);
    const corrupt = join(dir, "agent-access.mjs");
    writeFileSync(
      corrupt,
      "export function decide() { return { allowed: true }; }\n",
    );
    assert.equal(await loadPinnedAccessApi(corrupt), null);
    assert.deepEqual(
      resolveAccess(null, dir, "demo-repo", "gh pr create", ORG_URL),
      { code: 2, stdout: "" },
    );
  } finally {
    removeDir(dir);
  }
});

test("the packaged resolver uses committed catalog data and preserves fork scope", async () => {
  const dir = tempDir("pinned-resolver-workspace-");
  try {
    const { workspace } = buildWorkspace(dir, { level: "propose" });
    const scripts = defaultScripts(workspace);
    const api = await loadAccessApi(scripts.access);
    assert.ok(api);

    assert.equal(
      resolveAccess(
        api,
        scripts.catalog,
        "demo-repo",
        "git push origin main",
        ORG_URL,
      ).code,
      1,
    );
    assert.equal(
      resolveAccess(
        api,
        scripts.catalog,
        "demo-repo",
        "git push origin main",
        FORK_URL,
      ).code,
      0,
    );
    assert.equal(
      resolveAccess(api, scripts.catalog, "demo-repo", "gh pr create", ORG_URL)
        .code,
      0,
    );

    // A full worktree edit cannot raise the committed propose level.
    writeFileSync(
      join(scripts.catalog, "repos.json"),
      JSON.stringify({
        repos: [{ name: "demo-repo", tier: "standard", agentAccess: "full" }],
      }),
    );
    assert.equal(
      resolveAccess(
        api,
        scripts.catalog,
        "demo-repo",
        "git push origin main",
        ORG_URL,
      ).code,
      1,
    );

    const source = join(
      workspace,
      "projects",
      "repos",
      "simpsonm09-repo-standard",
      "scripts",
      "agent-access.mjs",
    );
    writeFileSync(source, "export const decide = () => ({ allowed: true });\n");
    assert.equal(
      resolveAccess(
        api,
        scripts.catalog,
        "demo-repo",
        "git push origin main",
        ORG_URL,
      ).code,
      1,
    );
  } finally {
    removeDir(dir);
  }
});

test("a missing committed catalog denies writes even when its working file grants full", async () => {
  const dir = tempDir("pinned-resolver-no-catalog-");
  try {
    const catalog = join(dir, "catalog");
    mkdirSync(catalog, { recursive: true });
    writeFileSync(
      join(catalog, "repos.json"),
      JSON.stringify({
        repos: [{ name: "demo-repo", tier: "standard", agentAccess: "full" }],
      }),
    );
    const api = await loadAccessApi(defaultScripts(dir).access);
    assert.ok(api);
    assert.deepEqual(
      resolveAccess(api, catalog, "demo-repo", "gh pr create", ORG_URL),
      { code: 2, stdout: "", catalogMissing: true },
    );
  } finally {
    removeDir(dir);
  }
});

test("standard checkout edits and branch changes do not replace the pinned resolver", async () => {
  const dir = tempDir("pinned-resolver-standard-git-");
  try {
    const { workspace } = buildWorkspace(dir, { level: "propose" });
    const standard = join(
      workspace,
      "projects",
      "repos",
      "simpsonm09-repo-standard",
    );
    const source = join(standard, "scripts", "agent-access.mjs");
    writeFileSync(
      source,
      "export const decide = () => ({ capability: null, allowed: true });\n",
    );
    const git = (args: string[]) =>
      execFileSync("git", ["-C", standard, ...args], {
        windowsHide: true,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    git(["init", "--quiet", "-b", "main"]);
    git(["add", "scripts/agent-access.mjs"]);
    git(["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"]);
    git(["checkout", "--quiet", "-b", "alternate"]);

    const scripts = defaultScripts(workspace);
    const api = await loadAccessApi(scripts.access);
    assert.ok(api);
    assert.equal(
      resolveAccess(api, scripts.catalog, "demo-repo", "gh pr merge 1", ORG_URL)
        .code,
      1,
    );
    writeFileSync(
      source,
      "export const decide = () => ({ capability: null, allowed: true });\n",
    );
    assert.equal(
      resolveAccess(api, scripts.catalog, "demo-repo", "gh pr merge 1", ORG_URL)
        .code,
      1,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
