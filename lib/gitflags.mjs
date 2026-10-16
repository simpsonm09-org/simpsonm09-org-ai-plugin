// The git flag grammar: the git global options that decide which repository is read, and the
// documented `git push` flags split by arity. It is the data plus the token read over it; the
// push observation that consumes them is lib/gitpush.mjs. Any flag outside the documented set
// makes the read untrustworthy, so the caller refuses to observe the push rather than guess at
// its arity.

// The documented `git push` booleans, from `git push -h` (git 2.55), including the
// `--no-<flag>` spellings git accepts.
const PUSH_BOOL_FLAGS = new Set([
  "-v",
  "--verbose",
  "--no-verbose",
  "-q",
  "--quiet",
  "--no-quiet",
  "--all",
  "--no-all",
  "--branches",
  "--no-branches",
  "--mirror",
  "--no-mirror",
  "--tags",
  "--no-tags",
  "-d",
  "--delete",
  "--no-delete",
  "-n",
  "--dry-run",
  "--no-dry-run",
  "--porcelain",
  "--no-porcelain",
  "-f",
  "--force",
  "--no-force",
  "--force-if-includes",
  "--no-force-if-includes",
  "--thin",
  "--no-thin",
  "-u",
  "--set-upstream",
  "--no-set-upstream",
  "--progress",
  "--no-progress",
  "--prune",
  "--no-prune",
  "--verify",
  "--no-verify",
  "--atomic",
  "--no-atomic",
  "-4",
  "--ipv4",
  "-6",
  "--ipv6",
  "--follow-tags",
  "--no-follow-tags",
  "--no-repo",
  "--no-receive-pack",
  "--no-exec",
  "--no-push-option",
]);

// `git push` options that take a separate value.
const PUSH_VALUE_FLAGS = new Set([
  "--repo",
  "--receive-pack",
  "--exec",
  "-o",
  "--push-option",
]);

// `git push` options whose value is attached with `=`, so the bare flag is also valid.
const PUSH_OPTIONAL_VALUE_FLAGS = [
  "--force-with-lease",
  "--signed",
  "--recurse-submodules",
];

// The git global options that only print and exit. A command that names one runs nothing.
const GIT_PRINT_ONLY = new Set([
  "--version",
  "--help",
  "--exec-path",
  "--html-path",
  "--man-path",
  "--info-path",
  "--list-cmds",
]);

// The git global options that do not change which repository is read.
const GIT_NOOP_GLOBALS = new Set([
  "-p",
  "--paginate",
  "-P",
  "--no-pager",
  "--no-optional-locks",
  "--no-lazy-fetch",
  "--no-advice",
  "--no-replace-objects",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
]);

// The git global options, and the subcommand after them. `-C` and `-c` are collected so the
// observation uses the same directory and config the command would.
/**
 * @param {string[]} words
 * @returns {{ globalArgs: string[], subcommand: string | undefined, options: string[], printOnly?: boolean } | null}
 */
export function gitGlobalOptions(words) {
  const globalArgs = [];
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (word === "-C" || word === "-c") {
      if (index + 1 >= words.length) return null;
      globalArgs.push(word, words[index + 1]);
      index += 2;
      continue;
    }
    if (GIT_PRINT_ONLY.has(word))
      return {
        globalArgs,
        subcommand: undefined,
        options: [],
        printOnly: true,
      };
    if (GIT_NOOP_GLOBALS.has(word)) {
      index += 1;
      continue;
    }
    if (word.startsWith("-")) return null;
    break;
  }
  return {
    globalArgs,
    subcommand: words[index],
    options: words.slice(index + 1),
  };
}

// The documented flags and positionals of one `git push`. Any flag outside the documented set
// makes the whole observation unsupported rather than guessing its arity.
/**
 * @param {string[]} tokens
 * @returns {{ flags: Set<string>, positionals: string[], repoArgument: string | null, deleteRefspec: boolean } | null}
 */
export function parsePushArguments(tokens) {
  const state = {
    flags: new Set(),
    positionals: [],
    repoArgument: null,
    deleteRefspec: false,
    literal: false,
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const step = readPushToken(tokens, index, state);
    if (!step) return null;
    index += step.extra;
  }
  return {
    flags: state.flags,
    positionals: state.positionals,
    repoArgument: state.repoArgument,
    deleteRefspec: state.deleteRefspec,
  };
}

// One token of a `git push`: a positional (under `--` too) or a documented flag, and the
// number of extra tokens it consumes (a value option takes the next word). Returns null for a
// flag outside the documented set, which makes the whole read untrustworthy.
/**
 * @param {string[]} tokens
 * @param {number} index
 * @param {{ flags: Set<string>, positionals: string[], repoArgument: string | null, deleteRefspec: boolean, literal: boolean }} state
 * @returns {{ extra: number } | null}
 */
function readPushToken(tokens, index, state) {
  const token = tokens[index];
  if (state.literal || !token.startsWith("-")) {
    if (token.startsWith(":")) state.deleteRefspec = true;
    state.positionals.push(token);
    return { extra: 0 };
  }
  if (token === "--") {
    state.literal = true;
    return { extra: 0 };
  }
  const attached = attachedValue(token);
  if (attached) return addPushFlag(attached.name, attached.value, state, 0);
  const kind = pushFlagKind(token);
  if (kind === "value") {
    const value = tokens[index + 1];
    if (value === undefined) return null;
    return addPushFlag(token, value, state, 1);
  }
  if (kind === "optional") {
    state.flags.add(token.split("=")[0]);
    return { extra: 0 };
  }
  if (kind === "bool") {
    state.flags.add(token);
    return { extra: 0 };
  }
  return null;
}

// The class of a documented `git push` flag: one that takes the next word, one whose value is
// attached with `=` (so the bare flag is valid too), or a boolean, or null when unmodeled.
/**
 * @param {string} token
 * @returns {"value" | "optional" | "bool" | null}
 */
function pushFlagKind(token) {
  if (PUSH_VALUE_FLAGS.has(token)) return "value";
  if (
    PUSH_OPTIONAL_VALUE_FLAGS.some(
      (name) => token === name || token.startsWith(`${name}=`),
    )
  )
    return "optional";
  if (PUSH_BOOL_FLAGS.has(token)) return "bool";
  return null;
}

// Record one flag under its tested name, remember a `--repo` value, and report how many extra
// tokens it consumed.
/**
 * @param {string} name
 * @param {string | null} value
 * @param {{ flags: Set<string>, repoArgument: string | null }} state
 * @param {number} extra
 * @returns {{ extra: number }}
 */
function addPushFlag(name, value, state, extra) {
  if (name === "--repo") state.repoArgument = value;
  state.flags.add(name);
  return { extra };
}

/**
 * @param {Set<string>} flags
 * @returns {boolean}
 */
export function hasForce(flags) {
  return (
    flags.has("-f") ||
    flags.has("--force") ||
    flags.has("--force-with-lease") ||
    flags.has("--force-if-includes") ||
    flags.has("--mirror")
  );
}

// The flags that write refs the command does not name, so the push is a multi-ref write
// regardless of any refspec it also carries. `--prune` belongs here: it removes every remote
// branch of the pushed namespace that has no local counterpart, which git 2.55 documents as
// respecting the refspecs, so a push that also carries one refspec still deletes others.
/**
 * @param {Set<string>} flags
 * @returns {boolean}
 */
export function hasBulk(flags) {
  return (
    flags.has("--tags") ||
    flags.has("--all") ||
    flags.has("--branches") ||
    flags.has("--mirror") ||
    flags.has("--follow-tags") ||
    flags.has("--prune") ||
    flags.has("-d") ||
    flags.has("--delete")
  );
}

// A value attached to a `git push` long option with `=`. git's own short options are not read
// this way: the documented set treats `-o` as a separate value, and an unmodeled spelling is
// `unsupported` rather than guessed.
/**
 * @param {string} token
 * @returns {{ name: string, value: string } | null}
 */
function attachedValue(token) {
  const equals = token.indexOf("=");
  if (equals <= 0) return null;
  const name = token.slice(0, equals);
  if (!PUSH_VALUE_FLAGS.has(name) && name !== "--repo") return null;
  return { name, value: token.slice(equals + 1) };
}
