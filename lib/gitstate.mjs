// Read-only Git observation for the agent-access observer. Every call runs the real `git`
// with an argument array and no shell, so a ref, a remote name, or a path taken from a
// command can never be interpolated into a shell string. This module is the only place the
// observer touches git state; the parsers (lib/intent.mjs, lib/gitpush.mjs, lib/ghcommand.mjs)
// are pure and receive one of these readers as their `git` argument. It also owns the reader
// plumbing every parser needs (`commandReader`, `memoize`) and the one identity key they
// compare destinations by, so no parser carries its own copy.
//
// A reader is `(args: string[]) => string | null`: the trimmed stdout of `git <args>`, or
// null when git fails, prints nothing, or does not answer inside the budget. The parser puts
// the observed command's own global options (`-C <path>`, `-c <key>=<value>`) in front of
// every args array, so the observation follows that command's directory and config overrides
// instead of guessing which repository the command meant.

import { execFileSync } from "node:child_process";
import { timeoutFor } from "./budget.mjs";

// One git read is bounded like every other child process the gate starts (lib/budget.mjs).
const GIT_TIMEOUT_MS = 5_000;

// The identity shapes the repo-standard catalog validator applies to an owner and a
// repository. A remote or an argument that does not match is not a destination this observer
// reports, which is the safe direction: an unparsed remote becomes an unresolved write.
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * @typedef {(args: string[]) => string | null} GitRead
 * @typedef {{ host: string, owner: string, repo: string }} GithubRepo
 */

// A reader bound to one command's global git options, memoized so one observation does not
// run the same git query twice. A context without a memo has no git state at all, and every
// caller treats a null reader as "cannot resolve".
/**
 * @param {{ memo: ((args: string[]) => string | null) | null }} context
 * @param {string[]} globalArgs
 * @returns {GitRead | null}
 */
export function commandReader(context, globalArgs) {
  if (!context.memo) return null;
  return (args) => context.memo([...globalArgs, ...args]);
}

/**
 * @param {GitRead} port
 * @returns {GitRead}
 */
export function memoize(port) {
  const cache = new Map();
  return (args) => {
    const key = args.join("\u0000");
    if (!cache.has(key)) cache.set(key, port(args));
    return cache.get(key);
  };
}

// The identity two github destinations are the same by, case-insensitively.
/**
 * @param {GithubRepo} destination
 * @returns {string}
 */
export function identityKey(destination) {
  return `${destination.host}/${destination.owner}/${destination.repo}`.toLowerCase();
}

/**
 * The GitHub identity a remote URL names, or null for a URL this observer does not model.
 * The documented remote forms are https, http, git, ssh, ssh://, and the scp-like
 * `user@host:owner/repo` form. A local path, a bare host name, or a path with anything but
 * `owner/repo` at the end is null, so nothing outside a GitHub identity is guessed.
 * @param {string} url
 * @returns {GithubRepo | null}
 */
export function parseGithubRepo(url) {
  if (typeof url !== "string") return null;
  const text = url.trim().replace(/\/+$/, "");
  if (text.length === 0) return null;
  const parts = urlParts(text);
  if (!parts) return null;
  return githubIdentity(parts.host, parts.path);
}

/**
 * The GitHub identity a gh `[HOST/]OWNER/REPO` argument names, or null. `gh -R owner/repo`
 * carries no host, and the host it defaults to is github.com.
 * @param {string} value
 * @returns {GithubRepo | null}
 */
export function parseRepoArgument(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const segments = text.split("/");
  if (segments.length === 2) return githubIdentity("github.com", text);
  if (segments.length !== 3) return null;
  const host = plausibleHost(segments[0]);
  return host ? githubIdentity(host, `${segments[1]}/${segments[2]}`) : null;
}

/**
 * A reader over the real `git` in one directory. options.exec exists for tests.
 * @param {string} cwd
 * @param {{ exec?: (args: string[], cwd: string | undefined) => string }} [options]
 * @returns {GitRead}
 */
export function gitReader(cwd, options = {}) {
  const exec = options.exec ?? defaultExec;
  return (args) => {
    try {
      const out = exec(args, cwd);
      const text =
        typeof out === "string" ? out.replace(/\r\n/g, "\n").trim() : "";
      return text.length > 0 ? text : null;
    } catch {
      return null;
    }
  };
}

/**
 * @returns {string}
 */
function defaultExec(args, cwd) {
  return execFileSync("git", args, {
    windowsHide: true,
    cwd: cwd ?? undefined,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: timeoutFor(GIT_TIMEOUT_MS),
  });
}

/**
 * Every remote name in the repository.
 * @param {GitRead} read
 * @returns {string[]}
 */
export function remoteNames(read) {
  return lines(read(["remote"]));
}

// The push URLs of a remote, in order. `--push --all` is the documented form: it reports the
// `pushurl` values when they are set and the fetch URL otherwise, and reports every one of
// them, so a remote with two push URLs (or a pushurl that differs from the fetch URL) is
// visible instead of silently reduced to one.
/**
 * @param {GitRead} read
 * @param {string} remote
 * @returns {string[]}
 */
export function remotePushUrls(read, remote) {
  return lines(read(["remote", "get-url", "--push", "--all", remote]));
}

/**
 * @param {GitRead} read
 * @param {string} remote
 * @returns {string | null}
 */
export function remoteFetchUrl(read, remote) {
  return read(["remote", "get-url", remote]);
}

// The default refspecs of a remote. Git uses these for a push that names no refspec of its
// own, and they take precedence over push.default.
/**
 * @param {GitRead} read
 * @param {string} remote
 * @returns {string[]}
 */
export function remotePushRefspecs(read, remote) {
  return lines(read(["config", "--get-all", `remote.${remote}.push`]));
}

/**
 * @param {GitRead} read
 * @param {string} key
 * @returns {string | null}
 */
export function configValue(read, key) {
  return read(["config", "--get", key]);
}

// The checked-out branch, or null on a detached HEAD.
/**
 * @param {GitRead} read
 * @returns {string | null}
 */
export function currentBranch(read) {
  return read(["symbolic-ref", "--quiet", "--short", "HEAD"]);
}

// The branch the remote's HEAD points at, from the remote-tracking symbolic ref a clone
// records. This is the only local evidence of the default branch; there is no network read,
// and an unset ref is null, which leaves the default branch unresolved.
/**
 * @param {GitRead} read
 * @param {string} remote
 * @returns {string | null}
 */
export function defaultBranchName(read, remote) {
  const full = read(["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]);
  const prefix = `refs/remotes/${remote}/`;
  return full?.startsWith(prefix) ? full.slice(prefix.length) : null;
}

// The full ref a bare ref name means, and whether the name is ambiguous. A name that is both
// a branch and a tag resolves to nothing here, because git refuses it too and a guess could
// turn a tag push into a branch push. The `show-ref --verify` probes are exact; the
// `rev-parse` fallback covers a remote-tracking ref and any other name git can resolve.
/**
 * @param {GitRead} read
 * @param {string} name
 * @returns {{ ref: string | null, ambiguous: boolean }}
 */
export function resolveRefName(read, name) {
  if (typeof name !== "string" || name.length === 0) {
    return { ref: null, ambiguous: false };
  }
  if (name.startsWith("refs/")) return { ref: name, ambiguous: false };
  if (name === "HEAD") return { ref: "HEAD", ambiguous: false };
  const asBranch = read(["show-ref", "--verify", `refs/heads/${name}`]);
  const asTag = read(["show-ref", "--verify", `refs/tags/${name}`]);
  if (asBranch && asTag) return { ref: null, ambiguous: true };
  if (asBranch) return { ref: `refs/heads/${name}`, ambiguous: false };
  if (asTag) return { ref: `refs/tags/${name}`, ambiguous: false };
  return {
    ref: read([
      "rev-parse",
      "--verify",
      "--quiet",
      "--symbolic-full-name",
      name,
    ]),
    ambiguous: false,
  };
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function lines(text) {
  if (!text) return [];
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// The host and path a URL string carries, in any documented git remote form.
/**
 * @param {string} text
 * @returns {{ host: string, path: string } | null}
 */
function urlParts(text) {
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/]*)\/(.+)$/.exec(text);
  if (scheme) {
    const host = plausibleHost(authorityHost(scheme[1]));
    return host ? { host, path: scheme[2] } : null;
  }
  const scp = /^(?:[^@/]+@)?([A-Za-z0-9.-]+):(.+)$/.exec(text);
  if (scp) {
    const host = plausibleHost(scp[1]);
    return host ? { host, path: scp[2] } : null;
  }
  const bare = /^([A-Za-z0-9.-]+\.[A-Za-z]{2,})\/(.+)$/.exec(text);
  if (bare) {
    const host = plausibleHost(bare[1]);
    return host ? { host, path: bare[2] } : null;
  }
  return null;
}

// The host of a URL authority, without a user or a port.
/**
 * @param {string} value
 * @returns {string}
 */
function authorityHost(value) {
  const withoutUser = value.includes("@")
    ? value.slice(value.indexOf("@") + 1)
    : value;
  const withoutPort = withoutUser.includes(":")
    ? withoutUser.slice(0, withoutUser.indexOf(":"))
    : withoutUser;
  return withoutPort.toLowerCase();
}

// A host this observer will name. github.com always qualifies; another host needs a dot, so
// a Windows drive letter ("C:") and a bare directory name are not read as a host.
/**
 * @param {string} host
 * @returns {string | null}
 */
function plausibleHost(host) {
  const value = (host ?? "").toLowerCase();
  if (value === "github.com") return value;
  if (!value.includes(".") || value.startsWith(".") || value.endsWith("."))
    return null;
  return value;
}

// Validate the identity under a host. The path must be exactly owner/repo, with the
// optional `.git` suffix git adds.
/**
 * @param {string} host
 * @param {string} path
 * @returns {GithubRepo | null}
 */
function githubIdentity(host, path) {
  if (!host || typeof path !== "string") return null;
  const clean = path.replace(/^\/+/, "").replace(/\/+$/, "");
  const segments = clean.split("/");
  if (segments.length !== 2) return null;
  const owner = segments[0];
  const raw = segments[1];
  const repo = raw.endsWith(".git") ? raw.slice(0, -4) : raw;
  if (!OWNER_PATTERN.test(owner) || !REPOSITORY_PATTERN.test(repo)) return null;
  return { host, owner, repo };
}
