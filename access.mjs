// The adapter between the shared decision (gate.mjs), the packaged access resolver, and the
// repo-standard GitHub App token broker. The OpenCode plugin
// (index.ts), the Claude Code hook, and the launcher all load them through this module,
// so the way a script is found, imported, spawned, and cached is written once. Every
// function here may touch the file system or spawn a process, which is why it lives apart
// from the pure gate.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPinnedAccessApi } from "./lib/pinned-access.mjs";
import {
  fallbackLevel,
  nodeRunner,
  remoteUrlFor,
  tokenUsable,
} from "./gate.mjs";
import { timeoutFor } from "./lib/budget.mjs";

export const OWNER = "simpsonm09-org";

// Every child process and every broker call is bounded, so a stuck call becomes a
// fail-closed answer rather than a hang. The hook's budget (lib/budget.mjs) bounds the
// whole run on top of these.
const CHILD_TIMEOUT_MS = 10_000;
const MINT_TIMEOUT_MS = 20_000;

/**
 * @typedef {{ code: number, stdout: string }} CliResult
 * @typedef {{ token: string, expires_at: string }} TokenCache
 * @typedef {{
 *   loadCommittedCatalog: (dir: string) => unknown | null,
 *   resolveLevel: (catalog: unknown, repoName: string) => { level?: unknown },
 *   decide: (level: string, command: string, remoteUrl?: string | null) => { capability: string | null, allowed: boolean },
 * }} AccessApi
 * @typedef {{ mintForRepo: (owner: string, repo: string) => Promise<{ token: string, expires_at: string }> }} TokenApi
 */

// The resolver ships with this package. The broker and catalog use trusted workspace clones.
/**
 * @param {string} workspaceRoot
 * @returns {{ access: string, token: string, catalog: string }}
 */
export function defaultScripts(workspaceRoot) {
  const repoStandard = join(
    workspaceRoot,
    "projects",
    "repos",
    "simpsonm09-repo-standard",
  );
  return {
    access: join(
      dirname(fileURLToPath(import.meta.url)),
      "runtime",
      "agent-access.mjs",
    ),
    token: join(repoStandard, "scripts", "agent-token.mjs"),
    catalog: join(
      workspaceRoot,
      "projects",
      "repos",
      "simpsonm09-repo-catalog",
    ),
  };
}

// Import a script and return its namespace, or null when it is missing or does not load.
/**
 * @param {string} script
 * @returns {Promise<any | null>}
 */
async function importModule(script) {
  if (!existsSync(script)) return null;
  try {
    return await import(pathToFileURL(script).href);
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @returns {value is AccessApi}
 */
function isAccessApi(value) {
  const api = /** @type {Partial<AccessApi> | null} */ (value);
  return (
    typeof api?.loadCommittedCatalog === "function" &&
    typeof api.resolveLevel === "function" &&
    typeof api.decide === "function"
  );
}

/**
 * @param {string} script
 * @returns {Promise<AccessApi | null>}
 */
export async function loadAccessApi(script) {
  const expected = join(
    dirname(fileURLToPath(import.meta.url)),
    "runtime",
    "agent-access.mjs",
  );
  if (script !== expected) return null;
  const access = await loadPinnedAccessApi(script);
  return isAccessApi(access) ? access : null;
}

/**
 * @param {string} script
 * @returns {Promise<TokenApi | null>}
 */
export async function loadTokenApi(script) {
  const broker = await importModule(script);
  return broker && typeof broker.mintForRepo === "function" ? broker : null;
}

// The catalog the decision reads from committed refs in the trusted clone.
/**
 * @param {AccessApi} api
 * @param {string} catalogDir
 * @returns {unknown}
 */
function catalogFor(api, catalogDir) {
  return api.loadCommittedCatalog(catalogDir);
}

// Decide one command with the resolver's own decide(). A resolver that throws is an
// unknown answer, which the decision treats conservatively.
/**
 * @param {AccessApi} api
 * @param {string} repo
 * @param {string} command
 * @param {string | null} remoteUrl
 * @returns {CliResult}
 */
function accessFromApi(api, catalogDir, repo, command, remoteUrl) {
  const catalog = catalogFor(api, catalogDir);
  if (catalog === null) return { code: 2, stdout: "", catalogMissing: true };
  const resolved = api.resolveLevel(catalog, repo);
  const level =
    typeof resolved.level === "string" ? resolved.level : fallbackLevel();
  let decision;
  try {
    decision = api.decide(level, command, remoteUrl);
  } catch {
    return {
      code: 2,
      stdout: "",
      catalogMissing: resolved.source === "unknown",
    };
  }
  return {
    code: decision.allowed ? 0 : 1,
    stdout: JSON.stringify({
      level,
      capability: decision.capability,
      allowed: decision.allowed,
    }),
    ...(resolved.source === "unknown" ? { catalogMissing: true } : {}),
  };
}

// Resolve access for one command. A missing or invalid packaged module is unknown (exit 2).
/**
 * @param {AccessApi | null} api
 * @param {string} catalogDir
 * @param {string} repo
 * @param {string} command
 * @param {string | null} remoteUrl
 * @returns {CliResult}
 */
export function resolveAccess(api, catalogDir, repo, command, remoteUrl) {
  if (api) {
    try {
      return accessFromApi(api, catalogDir, repo, command, remoteUrl);
    } catch {
      return { code: 2, stdout: "", catalogMissing: false };
    }
  }
  return { code: 2, stdout: "" };
}

// The resolved level for the context line. The command decision is the authority; the
// level is informational.
/**
 * @param {AccessApi | null} api
 * @param {string} repo
 * @param {string} catalogDir
 * @returns {string}
 */
export function levelFor(api, repo, catalogDir) {
  if (!api) return fallbackLevel();
  try {
    const catalog = catalogFor(api, catalogDir);
    if (catalog === null) return fallbackLevel();
    const resolved = api.resolveLevel(catalog, repo);
    return typeof resolved.level === "string"
      ? resolved.level
      : fallbackLevel();
  } catch {
    return fallbackLevel();
  }
}

// The token cache, one entry per repository. A token minted for one repository is never
// handed to another; that was the single-slot cache's defect.
/** @type {Map<string, TokenCache>} */
const tokenCache = new Map();

// Mint an installation token for one repository and cache it until it nears expiry. The
// token is never logged and never written to disk. A broker that does not answer in time
// is a failed mint.
/**
 * @param {TokenApi | null} api
 * @param {string} script
 * @param {string} repo
 * @returns {Promise<string | null>}
 */
export async function tokenFor(api, script, repo) {
  const cached = tokenCache.get(repo) ?? null;
  if (tokenUsable(cached, Date.now())) return cached?.token ?? null;
  const minted = await withTimeout(
    api ? mintInProcess(api, repo) : mintFromCli(script, repo),
    timeoutFor(MINT_TIMEOUT_MS),
  );
  if (!minted) return null;
  tokenCache.set(repo, minted);
  return minted.token;
}

// Resolve to null when the work does not finish in time, or fails.
/**
 * @template T
 * @param {Promise<T | null>} work
 * @param {number} ms
 * @returns {Promise<T | null>}
 */
function withTimeout(work, ms) {
  let timer;
  const deadline = new Promise((resolveDeadline) => {
    timer = setTimeout(() => resolveDeadline(null), ms);
  });
  return Promise.race([work.catch(() => null), deadline]).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * @param {TokenApi} api
 * @param {string} repo
 * @returns {Promise<TokenCache | null>}
 */
async function mintInProcess(api, repo) {
  try {
    const minted = await api.mintForRepo(OWNER, repo);
    if (!minted?.token || !minted.expires_at) return null;
    return { token: minted.token, expires_at: minted.expires_at };
  } catch {
    return null;
  }
}

// A broker that only ships a CLI is spawned with a Node runtime. The CLI prints one JSON
// object on stdout.
/**
 * @param {string} script
 * @param {string} repo
 * @returns {Promise<TokenCache | null>}
 */
async function mintFromCli(script, repo) {
  if (!existsSync(script)) return null;
  try {
    const stdout = execFileSync(
      nodeRunner(process.execPath),
      [script, `${OWNER}/${repo}`, "--json"],
      {
        windowsHide: true,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: timeoutFor(MINT_TIMEOUT_MS),
      },
    );
    const parsed = /** @type {Partial<TokenCache>} */ (
      JSON.parse(stdout ?? "")
    );
    if (!parsed.token || !parsed.expires_at) return null;
    return { token: parsed.token, expires_at: parsed.expires_at };
  } catch {
    return null;
  }
}

// The push URL of a remote, read with git in the directory. Not cached: a remote can be
// changed by any command, and a stale URL would decide a push wrongly.
/**
 * @param {string} remote
 * @param {string} cwd
 * @returns {string | null}
 */
export function gitRemoteUrl(remote, cwd) {
  return remoteUrlFor(remote, cwd, (args) =>
    execFileSync("git", args, {
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutFor(CHILD_TIMEOUT_MS),
    }),
  );
}
