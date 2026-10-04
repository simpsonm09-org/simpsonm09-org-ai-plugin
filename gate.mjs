// The pure core of the agent-access gate. It resolves which fleet repository a
// shell command acts on, whether the command needs an injected GitHub App
// token, and how a decision rewrites the command. Everything here is
// side-effect free so the wiring in index.ts stays testable with stubs.

import { isAbsolute, relative, resolve } from "node:path";

const FALLBACK_LEVEL = "read";

/**
 * @typedef {{ code: number, stdout: string }} CliResult
 * @typedef {(repo: string, command: string) => CliResult} Resolver
 * @typedef {"allow" | "deny" | "unknown"} Classification
 */

// The clone lives at <workspace>/projects/repos/<repo-name>.
/**
 * @param {string} cwd
 * @param {string} workspaceRoot
 * @returns {string | null}
 */
export function repoFromCwd(cwd, workspaceRoot) {
  if (!cwd || !workspaceRoot) return null;
  const reposRoot = resolve(workspaceRoot, "projects", "repos");
  const rel = relative(reposRoot, resolve(cwd));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  const name = rel.split(/[\\/]/)[0];
  return name.length > 0 ? name : null;
}

// A GitHub CLI command is the only command the gate injects a token for.
/**
 * @param {string} command
 * @returns {boolean}
 */
export function shouldInject(command) {
  return /^gh(\s|$)/.test(command);
}

// Rewrite a denied command into one that reports the reason and exits non-zero.
// The promise hook cannot fail by type, so denial is a rewritten command.
/**
 * @param {string} reason
 * @returns {string}
 */
export function denyCommand(reason) {
  return `printf '%s\\n' ${shellQuote(`agent-access: denied: ${reason}`)} >&2; exit 1`;
}

/**
 * @param {string} value
 * @returns {string}
 */
export function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * @param {CliResult} result
 * @returns {Classification}
 */
export function classifyResolver(result) {
  if (result.code === 0) return "allow";
  if (result.code === 1) return "deny";
  return "unknown";
}

// The resolver prints one JSON object on stdout in command mode. Anything that
// does not parse is an unknown level, which the caller treats conservatively.
/**
 * @param {string} stdout
 * @returns {{ level: string, capability: string | null } | null}
 */
export function parseResolverOutput(stdout) {
  if (!stdout) return null;
  try {
    const parsed = JSON.parse(stdout);
    if (typeof parsed?.level !== "string") return null;
    return {
      level: parsed.level,
      capability: typeof parsed.capability === "string" ? parsed.capability : null,
    };
  } catch {
    return null;
  }
}

// Fail closed on a write, and leave a read alone, when the resolver, the
// catalog, or the broker cannot answer. A gh command may be a remote write
// (pr merge, api, repo edit), so an unknown gh command fails closed too.
/**
 * @param {string} command
 * @returns {boolean}
 */
export function isWriteCommand(command) {
  if (shouldInject(command)) return true;
  return /(^|\s)(push|merge|delete|remove|create|close|reopen|tag|release|transfer|archive)(\s|$)/.test(
    command,
  );
}

// Refresh a cached installation token five minutes before it expires.
const TOKEN_SKEW_MS = 5 * 60 * 1000;

/**
 * @param {{ token: string, expires_at: string } | null} cache
 * @param {number} now
 * @returns {boolean}
 */
export function tokenUsable(cache, now) {
  if (!cache || !cache.token || !cache.expires_at) return false;
  const expires = Date.parse(cache.expires_at);
  return Number.isFinite(expires) && expires - now > TOKEN_SKEW_MS;
}

/**
 * @param {string} repo
 * @param {string} level
 * @returns {string}
 */
export function contextLine(repo, level) {
  return `agent-access: the repository ${repo} has agent access level "${level}".`;
}

// The shell wiring. Pure in the sense that every side effect (resolving the
// level, minting a token) is injected, so a test stubs both and asserts the
// edit. It mutates only the passed-in command holder and env, never logging.
/**
 * @param {{ command: string }} input
 * @param {Record<string, string | undefined>} env
 * @param {{
 *   cwd: string,
 *   workspaceRoot: string,
 *   resolve: Resolver,
 *   tokenFor: (repo: string) => Promise<string | null>,
 * }} deps
 * @returns {Promise<{ action: "pass" | "deny" | "inject", repo: string | null, level: string }>}
 */
export async function gateShellEdit(input, env, deps) {
  const repo = repoFromCwd(deps.cwd, deps.workspaceRoot);
  if (!repo) return { action: "pass", repo: null, level: FALLBACK_LEVEL };

  const command = input.command;
  const result = deps.resolve(repo, command);
  const classification = classifyResolver(result);
  const parsed = parseResolverOutput(result.stdout);
  const level = parsed?.level ?? FALLBACK_LEVEL;

  if (classification === "deny") {
    input.command = denyCommand(`${repo} denies this command at level "${level}"`);
    return { action: "deny", repo, level };
  }

  if (classification === "unknown") {
    if (isWriteCommand(command)) {
      input.command = denyCommand(`${repo} could not be resolved for a write`);
      return { action: "deny", repo, level };
    }
    return { action: "pass", repo, level };
  }

  if (shouldInject(command)) {
    const token = await deps.tokenFor(repo);
    if (!token) {
      input.command = denyCommand(`${repo} could not mint a token for a gh command`);
      return { action: "deny", repo, level };
    }
    env.GH_TOKEN = token;
    return { action: "inject", repo, level };
  }

  return { action: "pass", repo, level };
}

/**
 * @returns {string}
 */
export function fallbackLevel() {
  return FALLBACK_LEVEL;
}
