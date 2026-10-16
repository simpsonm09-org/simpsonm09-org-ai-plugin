// The environment variables that change which repository, host, or git configuration a command
// reads. The gate observes these by *name only*: a value is never copied, printed, compared, or
// logged, so a credential that happens to share the environment is never seen here. The narrow
// allowlist is the whole surface; anything outside it is not read.
//
// Two forms are told apart. A leading `NAME=value` assignment inside the command text is the
// command's own decision, and the observer rejects a governed write that carries one
// (lib/intent.mjs). A variable already set in the process environment is invisible in the
// command text, so the gate reads its name and rejects a governed write rather than observing
// the wrong repository.

// The names that change which repository or which git/gh configuration a read uses. The set is
// deliberately small: a name that only affects output or credentials (GH_TOKEN, GH_DEBUG,
// GITHUB_TOKEN, ...) is not here, so nothing credential-shaped is ever observed.
export const REPOSITORY_ENV = Object.freeze([
  "GH_HOST",
  "GH_REPO",
  "GH_CONFIG_DIR",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_COUNT",
]);

// The `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` pair form of an inline config override. A
// prefix match is the only way to name them, and only the key's *name* is ever read.
export const REPOSITORY_ENV_PREFIXES = Object.freeze([
  "GIT_CONFIG_KEY_",
  "GIT_CONFIG_VALUE_",
]);

/**
 * Whether a NAME=value assignment's name changes which repository is read.
 * @param {string} name
 * @returns {boolean}
 */
export function isRepositoryEnvironmentName(name) {
  const upper = String(name).toUpperCase();
  if (REPOSITORY_ENV.includes(upper)) return true;
  return REPOSITORY_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

// The names from the allowlist that are set, sorted and de-duplicated. Names only: the values
// are never returned, so a snapshot is safe to pass around and to name in a denial reason.
/**
 * @param {Record<string, string | undefined> | null | undefined} [env]
 * @returns {string[]}
 */
export function environmentSnapshot(env = process.env) {
  if (!env || typeof env !== "object") return [];
  const found = new Set();
  for (const name of REPOSITORY_ENV) {
    if (env[name] !== undefined) found.add(name);
  }
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (REPOSITORY_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix)))
      found.add(upper);
  }
  return [...found].sort();
}
