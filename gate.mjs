// The shared decision for one shell command. Both harnesses reach the same answer
// through this module: the OpenCode plugin (index.ts) calls gateShellEdit, which also
// rewrites a denied command and injects GH_TOKEN; the Claude Code hook calls decideShell
// and maps its action onto a PreToolUse answer. The rules live here and nowhere else:
// which fleet repository a directory belongs to, what the resolver decides for a
// command, and when a gh command gets a token.
//
// The decision is the resolver's, made from the first command only (see README "Known
// limits"). This module adds no segment analysis, verb table, or token-name rule. The
// adapters do the I/O (access.mjs, lib/fleet.mjs); this module only sees their answers.

import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  canonicalCommand,
  programName,
  readShellWord,
} from "./lib/program.mjs";

const FALLBACK_LEVEL = "read";

/**
 * @typedef {{ code: number, stdout: string }} CliResult
 * @typedef {(repo: string, command: string, remoteUrl: string | null) => CliResult} Resolver
 * @typedef {(remote: string, cwd: string) => string | null} RemoteUrlLookup
 * @typedef {"allow" | "deny" | "unknown"} Classification
 * @typedef {{ action: "pass" | "deny" | "inject", repo: string | null, level: string, reason?: string }} Decision
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

// A worktree lives at <workspace>/projects/worktrees/<name>. It is not named after its
// repository, so the caller resolves it through git (see repoFromCommonDir).
/**
 * @param {string} cwd
 * @param {string} workspaceRoot
 * @returns {boolean}
 */
export function isWorktreePath(cwd, workspaceRoot) {
  if (!cwd || !workspaceRoot) return false;
  const rel = relative(
    resolve(workspaceRoot, "projects", "worktrees"),
    resolve(cwd),
  );
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// A worktree's git common dir is the clone's .git directory, <workspace>/projects/repos/
// <repo>/.git. It names the repository only when the clone sits directly under repos.
/**
 * @param {string | null} commonDir
 * @param {string} workspaceRoot
 * @returns {string | null}
 */
export function repoFromCommonDir(commonDir, workspaceRoot) {
  if (!commonDir || !workspaceRoot || !isAbsolute(commonDir)) return null;
  if (basename(commonDir) !== ".git") return null;
  const reposRoot = resolve(workspaceRoot, "projects", "repos");
  const rel = relative(reposRoot, dirname(commonDir));
  if (isAbsolute(rel)) return null;
  const parts = rel.split(/[\\/]/);
  if (parts.length !== 1 || parts[0] === "" || parts[0] === "..") return null;
  return parts[0];
}

// A gh command is the only command the gate injects a token for. The test is on the first
// word after canonicalCommand, so a leading space or tab is not a gh command here, as before.
/**
 * @param {string} command
 * @returns {boolean}
 */
export function shouldInject(command) {
  return /^gh(\s|$)/.test(canonicalCommand(command));
}

// Split a shell command on whitespace and quotes, the same light parse the resolver
// uses. Only enough to reach the command and its git push remote. A PowerShell command is
// split by the PowerShell reading of its words (lib/program.mjs), so a doubled quote and a
// backtick mean what PowerShell makes of them.
/**
 * @param {string} command
 * @param {"bash" | "powershell"} [shell]
 * @returns {string[]}
 */
export function tokenize(command, shell = "bash") {
  if (shell === "powershell") return tokenizePowerShell(command);
  return (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
    .map((token) => token.replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

// The words of a PowerShell command. A word the reader does not take (an unquoted $, backtick,
// or parenthesis) is kept as typed, so a push with a variable in it is still seen as a push.
/**
 * @param {string} command
 * @returns {string[]}
 */
function tokenizePowerShell(command) {
  const words = [];
  let i = 0;
  while (i < command.length) {
    if (/\s/.test(command[i])) {
      i += 1;
      continue;
    }
    const read = readShellWord(command, i, "powershell");
    const end = read ? read.end : i + command.slice(i).match(/^\S+/)[0].length;
    const word = read ? read.word : command.slice(i, end);
    if (word) words.push(word);
    i = end;
  }
  return words;
}

// The remote a git push targets: the first non-flag token after "git push", defaulting
// to "origin" when absent. A token naming a ref ("main", "refs/heads/x", or "X:Y") is a
// refspec, not a remote, so a bare push still reads as origin. Returns null for a
// command that is not a git push, so the caller passes no URL.
/**
 * @param {string} command
 * @param {"bash" | "powershell"} [shell]
 * @returns {string | null}
 */
export function pushRemote(command, shell = "bash") {
  const parts = tokenize(command, shell);
  if (programName(parts[0] ?? "") !== "git" || parts[1] !== "push") return null;
  const tokens = parts.slice(2).filter((token) => !token.startsWith("-"));
  const first = tokens[0];
  if (!first || looksLikeRefspec(first)) return "origin";
  return first;
}

// A refspec names a ref. "main" and "refs/heads/main" are the shorthand and the full
// form, a colon separates source and destination, and a bare remote name has no colon
// and no slash.
/**
 * @param {string} token
 * @returns {boolean}
 */
function looksLikeRefspec(token) {
  if (token.includes(":")) return true;
  if (token === "HEAD") return true;
  if (token.startsWith("refs/") || token.startsWith("refs\\")) return true;
  if (!token.includes("/")) return false;
  const [head] = token.split(/[/\\]/);
  return head === "refs" || head === "heads";
}

// Resolve a remote name to its URL inside the command's cwd with `git remote get-url`.
// A cwd with no git repo, an unknown remote, or a missing git binary yields null, so the
// resolver keeps its governed default instead of guessing scope.
/**
 * @param {string} remote
 * @param {string} cwd
 * @param {(args: string[]) => string} exec
 * @returns {string | null}
 */
export function remoteUrlFor(remote, cwd, exec) {
  if (!remote || !cwd) return null;
  try {
    const url = exec(["-C", cwd, "remote", "get-url", remote]);
    const trimmed = (url ?? "").trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * The reason line every denial carries, shared by both harnesses.
 * @param {string} reason
 * @returns {string}
 */
export function denyMessage(reason) {
  return `agent-access: denied: ${reason}`;
}

// Rewrite a denied command into one that reports the reason and exits non-zero. The
// promise hook cannot fail by type, so denial is a rewritten command. The OpenCode shell
// runs a real shell, so the syntax must match it: PowerShell on Windows, POSIX elsewhere.
/**
 * @param {string} reason
 * @param {string} [shell]
 * @returns {string}
 */
export function denyCommand(reason, shell = "") {
  const message = denyMessage(reason);
  if (isPowerShell(shell))
    return `Write-Error ${powerShellQuote(message)}; exit 1`;
  return `printf '%s\\n' ${shellQuote(message)} >&2; exit 1`;
}

// The OpenCode shell hook names the shell it will run. Match the PowerShell family by
// the file's base name so a full path still resolves.
/**
 * @param {string} shell
 * @returns {boolean}
 */
export function isPowerShell(shell) {
  const name = fileName(shell ?? "").toLowerCase();
  return /^(pwsh|powershell)(\.exe)?$/.test(name);
}

// The last path segment of a path written with either separator. Node's basename only
// splits on the separator of the running platform, so a Windows path on Linux (or a
// POSIX path on Windows) needs both separators handled here.
/**
 * @param {string} path
 * @returns {string}
 */
export function fileName(path) {
  return basename(path.trim().replace(/\\/g, "/"));
}

/**
 * @param {string} value
 * @returns {string}
 */
export function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// A PowerShell single-quoted string escapes an embedded quote by doubling it.
/**
 * @param {string} value
 * @returns {string}
 */
export function powerShellQuote(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

// Pick the interpreter for a spawned script. The OpenCode server runs the plugin inside
// its own binary, so process.execPath is the OpenCode CLI, not Node. Use process.execPath
// only when it is a real Node or Bun runtime; otherwise fall back to `node` on PATH.
/**
 * @param {string} execPath
 * @returns {string}
 */
export function nodeRunner(execPath) {
  const name = fileName(execPath ?? "").toLowerCase();
  return /^(node|node\.exe|bun|bun\.exe)$/.test(name) ? execPath : "node";
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

// The resolver prints one JSON object on stdout in command mode. Anything that does not
// parse is an unknown level, which the caller treats conservatively.
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
      capability:
        typeof parsed.capability === "string" ? parsed.capability : null,
    };
  } catch {
    return null;
  }
}

// Fail closed on a write, and leave a read alone, when the resolver cannot answer. A gh
// command may be a remote write (pr merge, api, repo edit), so an unknown gh command
// fails closed too.
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
  if (!cache?.token || !cache.expires_at) return false;
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

/**
 * @returns {string}
 */
export function fallbackLevel() {
  return FALLBACK_LEVEL;
}

// The answer when the working directory cannot be resolved to a fleet repository (git could
// not run, for instance). It is the same rule as a command the resolver cannot answer: a
// write-like command is denied, and any other command passes.
/**
 * @param {string} command
 * @returns {Decision}
 */
function unresolvedAnswer(command) {
  if (isWriteCommand(command)) {
    return {
      action: "deny",
      repo: null,
      level: FALLBACK_LEVEL,
      reason:
        "the working directory could not be resolved to a fleet repository for this write",
    };
  }
  return { action: "pass", repo: null, level: FALLBACK_LEVEL };
}

// The decision for one command, with no side effects: no token, no environment, no
// rewrite. The repository comes from deps.lookup(cwd), which never throws: it answers
// { repo } for a fleet directory, { repo: null } for any other directory, and
// { repo: null, unresolved: true } when the lookup could not run. Without a lookup, the
// repos-only path rule answers. A cwd outside a fleet repository passes without a resolver
// call.
/**
 * @param {{ command: string, shell?: "bash" | "powershell" }} input the dialect defaults to bash
 * @param {{
 *   cwd: string,
 *   workspaceRoot?: string,
 *   lookup?: (cwd: string) => { repo: string | null, unresolved?: boolean },
 *   resolve: Resolver,
 *   remoteUrl: RemoteUrlLookup,
 * }} deps
 * @returns {Decision}
 */
export function decideShell(input, deps) {
  const found = deps.lookup
    ? deps.lookup(deps.cwd)
    : { repo: repoFromCwd(deps.cwd, deps.workspaceRoot ?? "") };
  const command = canonicalCommand(input.command);
  if (found.unresolved) return unresolvedAnswer(command);
  const repo = found.repo;
  if (!repo) return { action: "pass", repo: null, level: FALLBACK_LEVEL };

  const remote = pushRemote(command, input.shell);
  const remoteUrl = remote ? deps.remoteUrl(remote, deps.cwd) : null;
  const result = deps.resolve(repo, command, remoteUrl);
  const classification = classifyResolver(result);
  const level = parseResolverOutput(result.stdout)?.level ?? FALLBACK_LEVEL;

  if (classification === "deny") {
    return {
      action: "deny",
      repo,
      level,
      reason: `${repo} denies this command at level "${level}"`,
    };
  }

  if (classification === "unknown") {
    if (isWriteCommand(command)) {
      return {
        action: "deny",
        repo,
        level,
        reason: `${repo} could not be resolved for a write`,
      };
    }
    return { action: "pass", repo, level };
  }

  if (shouldInject(command)) return { action: "inject", repo, level };
  return { action: "pass", repo, level };
}

// The OpenCode side of the decision. It applies the decision to the command holder and
// the environment: a denial rewrites the command, and an injection mints the token for
// the repository and sets GH_TOKEN. A token that cannot be minted is a denial, as before.
/**
 * @param {{ command: string, shell?: string }} input
 * @param {Record<string, string | undefined>} env
 * @param {{
 *   cwd: string,
 *   workspaceRoot?: string,
 *   lookup?: (cwd: string) => { repo: string | null, unresolved?: boolean },
 *   resolve: Resolver,
 *   remoteUrl: RemoteUrlLookup,
 *   tokenFor: (repo: string) => Promise<string | null>,
 * }} deps
 * @returns {Promise<Decision>}
 */
export async function gateShellEdit(input, env, deps) {
  const decision = decideShell(input, deps);

  if (decision.action === "deny") {
    input.command = denyCommand(decision.reason ?? "", input.shell);
    return decision;
  }

  if (decision.action === "inject") {
    const token = await deps.tokenFor(decision.repo ?? "");
    if (!token) {
      const reason = `${decision.repo} could not mint a token for a gh command`;
      input.command = denyCommand(reason, input.shell);
      return {
        action: "deny",
        repo: decision.repo,
        level: decision.level,
        reason,
      };
    }
    env.GH_TOKEN = token;
  }

  return decision;
}
