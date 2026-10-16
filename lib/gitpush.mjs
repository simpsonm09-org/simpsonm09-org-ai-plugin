// The `git` half of the command observer: the git global options, the alias check, and the
// whole `git push` observation. It reads git state through the injected read-only reader
// (lib/gitstate.mjs) and returns the shared Observation shape (lib/observation.mjs). It is
// pure: the same words and the same git state always give the same observation.
//
// Bounded forms only, and the bounds are the contract:
//   - `git` global options are `-C <path>` and `-c <key>=<value>` (passed through to every
//     read). Any other global option is `unsupported`.
//   - `git push` flags and value flags are the documented set from `git push -h`; an
//     unmodeled flag is `unsupported`.
//   - `--no-verify` is parsed as an ordinary flag. It is not a reason to stop observing:
//     the observation happens before the command runs and the hook cannot be skipped by it.

import {
  commandReader,
  configValue,
  currentBranch,
  defaultBranchName,
  identityKey,
  parseGithubRepo,
  remoteFetchUrl,
  remoteNames,
  remotePushRefspecs,
  remotePushUrls,
  resolveRefName,
} from "./gitstate.mjs";
import {
  localObservation,
  unsupported,
  writeObservation,
} from "./observation.mjs";

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

// The names a branch is treated as a default branch by when git records no default branch for
// the remote. They are only a fallback: when the remote-tracking HEAD is present, the
// comparison is against that branch, whatever it is called. Treating a conventionally named
// branch as the default can only deny a push, never allow one, so the fallback is the safe
// direction when a clone has no `refs/remotes/<remote>/HEAD` (the current classifier also
// special-cases these names).
const CONVENTIONAL_DEFAULTS = new Set(["main", "master"]);

/**
 * One `git` command, classified. Only `push` is observed; every other subcommand is local.
 * @param {string[]} words the tokens after the `git` program word
 * @param {{ shell: "bash" | "powershell", cwd: string | null, memo: ((args: string[]) => string | null) | null }} context
 * @returns {import("./observation.mjs").Observation}
 */
export function classifyGit(words, context) {
  const globals = gitGlobalOptions(words);
  if (!globals)
    return unsupported("a git global option this observer does not model");
  if (globals.printOnly)
    return localObservation("a git option that only prints");
  if (globals.subcommand === undefined)
    return localObservation("a git command with no subcommand");
  const alias = governedAlias(
    commandReader(context, globals.globalArgs),
    globals.subcommand,
  );
  if (alias) return unsupported(alias.reason);
  if (globals.subcommand !== "push")
    return localObservation(`the local git command "${globals.subcommand}"`);
  if (globals.options.includes("-h") || globals.options.includes("--help"))
    return localObservation("the git push help text");
  return observePush(globals.options, globals.globalArgs, context);
}

// A git alias can stand in for a write, and the alias name says nothing about it. A shell
// alias (`!…`) is outside this observer entirely, and an alias whose expansion starts with
// `push` (including one that shadows the built-in) is a governed write this observer does not
// resolve, so both are `unsupported`. Any other alias is `local`, and an alias chain or a
// variable-built alias is not resolved, which is a documented limit rather than a claim.
/**
 * @param {((args: string[]) => string | null) | null} read
 * @param {string | undefined} subcommand
 * @returns {{ alias: string, reason: string } | null}
 */
export function governedAlias(read, subcommand) {
  if (!read || subcommand === undefined) return null;
  const alias = configValue(read, `alias.${subcommand}`);
  if (!alias) return null;
  const first = alias.trim().split(/\s+/)[0] ?? "";
  if (!alias.trimStart().startsWith("!") && first !== "push") return null;
  return {
    alias,
    reason: `the git alias "${subcommand}" stands for a governed write this observer does not resolve`,
  };
}

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

// The whole `git push` observation: the destination from git's own push configuration, and
// the refs from the refspecs (or, when there are none, from `remote.<r>.push`, then
// push.default, then the current branch).
/**
 * @param {string[]} tokens
 * @param {string[]} globalArgs
 * @param {{ shell: "bash" | "powershell", cwd: string | null, memo: ((args: string[]) => string | null) | null }} context
 * @returns {import("./observation.mjs").Observation}
 */
function observePush(tokens, globalArgs, context) {
  const parsed = parsePushArguments(tokens);
  if (!parsed)
    return unsupported("a git push option this observer does not model");
  const read = commandReader(context, globalArgs);
  const bulk = hasBulk(parsed.flags);
  const deleting = parsed.flags.has("-d") || parsed.flags.has("--delete");
  const destination = pushDestination(parsed, read);
  const implicit =
    destination.defaultRefspecs && destination.refspecs.length === 0
      ? implicitRefspecs(read, destination.remoteName)
      : null;
  const force =
    hasForce(parsed.flags) ||
    destination.refspecs.some((spec) => spec.startsWith("+")) ||
    implicit?.force === true;
  const defaultName = destination.destination
    ? defaultBranchFor(read, destination.destination)
    : null;
  const refs = implicit
    ? implicit.refs(defaultName)
    : refspecRefs(destination.refspecs, read, { defaultName });
  const effectiveBulk = bulk || implicit?.bulk === true;
  const capability = pushCapability(effectiveBulk, refs);
  const refsResolved =
    refs.length > 0
      ? refs.every((ref) => ref.kind !== "unknown")
      : effectiveBulk;
  const resolved =
    destination.resolved && refsResolved && implicit?.none !== true;

  return writeObservation({
    program: "git",
    operation: "push",
    capability,
    resolved,
    destination: destination.destination,
    destinationSource: destination.source,
    refs,
    force,
    delete: deleting || parsed.deleteRefspec,
    reason: pushReason(capability, destination, refs),
  });
}

// The documented flags and positionals of one `git push`. Any flag outside the documented set
// makes the whole observation unsupported rather than guessing its arity.
/**
 * @param {string[]} tokens
 * @returns {{ flags: Set<string>, positionals: string[], repoArgument: string | null, deleteRefspec: boolean } | null}
 */
function parsePushArguments(tokens) {
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
function hasForce(flags) {
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
function hasBulk(flags) {
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

// Which repository a push reaches, how it was learned, and which tokens are its refspecs.
// git's grammar is `git push [<repository> [<refspec>…]]`: the first positional is always the
// repository, so it is a refspec only after a repository token is taken. A named remote is
// resolved through its push URL list (pushurl when set, every one of them), never through a
// remote *name*. `defaultRefspecs` is true only when the command named a repository git can
// actually push to, which is what lets `remote.<r>.push` and `push.default` fill in the refs;
// an unknown repository has none.
/**
 * @param {{ repoArgument: string | null, positionals: string[] }} parsed
 * @param {((args: string[]) => string | null) | null} read
 * @returns {{
 *   destination: import("./observation.mjs").Destination | null,
 *   resolved: boolean,
 *   source: import("./observation.mjs").Observation["destinationSource"],
 *   remoteName: string | null,
 *   refspecs: string[],
 *   defaultRefspecs: boolean,
 * }}
 */
function pushDestination(parsed, read) {
  const unresolved = (remoteName, refspecs, defaultRefspecs = false) => ({
    destination: null,
    resolved: false,
    source: /** @type {const} */ ("none"),
    remoteName,
    refspecs,
    defaultRefspecs,
  });

  let remoteToken = parsed.repoArgument;
  let refspecs = parsed.positionals;
  if (remoteToken === null && refspecs.length > 0) {
    remoteToken = refspecs[0];
    refspecs = refspecs.slice(1);
    // A token that is neither URL-like nor a configured remote is an unknown repository,
    // not a refspec on the default remote: git reads it as a path or refuses it, and
    // neither is a GitHub push this observer can name. Treating it as a refspec would
    // report a destination and a branch the command never reaches.
    if (!isUrlLike(remoteToken) && !namesRemote(read, remoteToken))
      return unresolved(null, refspecs);
  }
  if (remoteToken === null) {
    const name = read ? defaultPushRemote(read) : null;
    if (name === null) return unresolved(null, refspecs);
    return {
      ...remoteDestination(read, name),
      source: "git-default",
      remoteName: name,
      refspecs,
      defaultRefspecs: true,
    };
  }
  if (isUrlLike(remoteToken)) {
    const parsedUrl = parseGithubRepo(remoteToken);
    return {
      destination: parsedUrl,
      resolved: parsedUrl !== null,
      source: "url",
      remoteName: remoteNameForDestination(read, parsedUrl),
      refspecs,
      defaultRefspecs: true,
    };
  }
  if (!read) return unresolved(remoteToken, refspecs);
  return {
    ...remoteDestination(read, remoteToken),
    remoteName: remoteToken,
    refspecs,
    defaultRefspecs: true,
  };
}

// The destination a named remote reaches: every push URL it has, as github identities. More
// than one distinct identity, or a URL this observer cannot parse, leaves the destination
// unresolved so a governed write fails closed.
/**
 * @param {((args: string[]) => string | null) | null} read
 * @param {string} name
 * @returns {{ destination: import("./observation.mjs").Destination | null, resolved: boolean, source: import("./observation.mjs").Observation["destinationSource"] }}
 */
function remoteDestination(read, name) {
  if (!read) return { destination: null, resolved: false, source: "remote" };
  const urls = remotePushUrls(read, name);
  if (urls.length === 0)
    return { destination: null, resolved: false, source: "remote" };
  const identities = urls.map(parseGithubRepo);
  if (identities.some((identity) => identity === null))
    return { destination: null, resolved: false, source: "remote" };
  const distinct = new Map(
    identities.map((identity) => [identityKey(identity), identity]),
  );
  if (distinct.size !== 1)
    return { destination: null, resolved: false, source: "pushurl" };
  const fetch = remoteFetchUrl(read, name);
  const source = fetch && fetch !== urls[0] ? "pushurl" : "remote";
  return { destination: [...distinct.values()][0], resolved: true, source };
}

// git's documented default push remote: branch.<b>.pushRemote, then remote.pushDefault, then
// branch.<b>.remote, then origin. (Verified against git 2.55 with `git push --dry-run` in a
// controlled repo: the branch's pushRemote wins over remote.pushDefault, which wins over
// branch.<b>.remote, which wins over origin.)
/**
 * @param {(args: string[]) => string | null} read
 * @returns {string | null}
 */
function defaultPushRemote(read) {
  const branch = currentBranch(read);
  if (branch) {
    const pushRemote = configValue(read, `branch.${branch}.pushRemote`);
    if (pushRemote) return pushRemote;
  }
  const pushDefault = configValue(read, "remote.pushDefault");
  if (pushDefault) return pushDefault;
  if (branch) {
    const remote = configValue(read, `branch.${branch}.remote`);
    if (remote) return remote;
  }
  return "origin";
}

// The branch the remote's HEAD points at, found through a remote that reaches the
// destination. A push to an explicit URL still resolves its default branch when that URL is
// also a configured remote. The remote-tracking symbolic ref is the only local evidence, and
// an unset one leaves the default branch unresolved.
/**
 * @param {((args: string[]) => string | null) | null} read
 * @param {import("./observation.mjs").Destination} destination
 * @returns {string | null}
 */
function defaultBranchFor(read, destination) {
  const name = remoteNameForDestination(read, destination);
  return name === null ? null : defaultBranchName(read, name);
}

// The first configured remote whose push or fetch URL reaches the destination, or null.
/**
 * @param {((args: string[]) => string | null) | null} read
 * @param {import("./observation.mjs").Destination | null} destination
 * @returns {string | null}
 */
function remoteNameForDestination(read, destination) {
  if (!read || !destination) return null;
  const key = identityKey(destination);
  for (const name of remoteNames(read)) {
    const urls = [
      ...remotePushUrls(read, name),
      remoteFetchUrl(read, name),
    ].filter(Boolean);
    const reaches = urls.some((url) => {
      const parsed = parseGithubRepo(url);
      return parsed !== null && identityKey(parsed) === key;
    });
    if (reaches) return name;
  }
  return null;
}

// The refspecs git uses when the command names none: remote.<r>.push first, then push.default
// (matching is a multi-ref write, current and upstream name one branch), then the current
// branch.
/**
 * @param {((args: string[]) => string | null) | null} read
 * @param {string | null} remoteName
 * @returns {{ refs: (defaultName: string | null) => import("./observation.mjs").ObservedRef[], bulk: boolean, none: boolean, force: boolean }}
 */
function implicitRefspecs(read, remoteName) {
  if (!read) return { refs: () => [], bulk: false, none: true, force: false };
  if (remoteName) {
    if (
      (configValue(read, `remote.${remoteName}.mirror`) ?? "").toLowerCase() ===
      "true"
    )
      return { refs: () => [], bulk: true, none: false, force: false };
    const configured = remotePushRefspecs(read, remoteName);
    if (configured.length > 0)
      return {
        refs: (defaultName) => refspecRefs(configured, read, { defaultName }),
        bulk: false,
        none: false,
        force: configured.some((spec) => spec.startsWith("+")),
      };
  }
  const pushDefault = (configValue(read, "push.default") ?? "").toLowerCase();
  if (pushDefault === "matching")
    return { refs: () => [], bulk: true, none: false, force: false };
  if (pushDefault === "nothing")
    return { refs: () => [], bulk: false, none: true, force: false };
  const branch = currentBranch(read);
  if (branch === null)
    return { refs: () => [], bulk: false, none: true, force: false };
  const target =
    pushDefault === "upstream" || pushDefault === "tracking"
      ? (configValue(read, `branch.${branch}.merge`) ?? `refs/heads/${branch}`)
      : `refs/heads/${branch}`;
  return {
    refs: (defaultName) => refspecRefs([target], read, { defaultName }),
    bulk: false,
    none: false,
    force: false,
  };
}

/**
 * @param {string[]} specs
 * @param {((args: string[]) => string | null) | null} read
 * @param {{ defaultName: string | null }} options
 * @returns {import("./observation.mjs").ObservedRef[]}
 */
function refspecRefs(specs, read, options) {
  return specs.map((spec) => refOf(spec, read, options));
}

// One refspec as the ref it writes. The destination side of a `src:dst` form is the ref the
// remote writes; without a colon the source name is the ref. An empty source (`:dst`) is a
// deletion. An empty destination is not a refspec git accepts: git 2.55 refuses
// `git push origin feat/x:` with "fatal: invalid refspec" (verified with a local `--dry-run`
// against a new bare repository), so it is never normalized to the source name and never
// read as a deletion. It stays `unknown`, which leaves the push unresolved and denied. The
// lone `:` (empty source and destination) is git's documented matching form and is likewise
// left unresolved rather than guessed. A wildcard is a multi-ref write, which is never a
// single branch.
/**
 * @param {string} spec
 * @param {((args: string[]) => string | null) | null} read
 * @param {{ defaultName: string | null }} options
 * @returns {import("./observation.mjs").ObservedRef}
 */
function refOf(spec, read, options) {
  const text = spec.startsWith("+") ? spec.slice(1) : spec;
  const colon = text.indexOf(":");
  if (colon === -1) return refForTarget(text, read, options);
  const destination = text.slice(colon + 1);
  if (destination.length === 0)
    return { kind: "unknown", name: text, isDefault: null };
  return refForTarget(destination, read, options);
}

/**
 * @param {string} target
 * @param {((args: string[]) => string | null) | null} read
 * @param {{ defaultName: string | null }} options
 * @returns {import("./observation.mjs").ObservedRef}
 */
function refForTarget(target, read, options) {
  const ref = refKindFor(target, read);
  return {
    kind: ref.kind,
    name: ref.name,
    isDefault: defaultState(ref, options.defaultName),
  };
}

// Whether a ref is the default branch, as a tri-state. `true` is the resolved default branch
// (or a conventionally named branch when the remote records none), `false` is a resolved
// non-default branch, and `null` is a branch whose default branch could not be resolved. The
// resolver's own push rule requires exactly `false`, so `null` denies a governed branch push.
/**
 * @param {{ kind: string, name: string }} ref
 * @param {string | null} defaultName
 * @returns {boolean | null}
 */
function defaultState(ref, defaultName) {
  if (ref.kind !== "branch") return null;
  if (defaultName !== null) return ref.name === defaultName;
  return CONVENTIONAL_DEFAULTS.has(ref.name) ? true : null;
}

// The ref kind a name means, resolved from git where the name is bare.
/**
 * @param {string} target
 * @param {((args: string[]) => string | null) | null} read
 * @returns {{ kind: string, name: string }}
 */
function refKindFor(target, read) {
  if (target.includes("*")) return { kind: "other", name: target };
  if (target === "HEAD") return headRef(read, target);
  const qualified = classifyQualifiedRef(target);
  if (qualified) return qualified;
  if (!read) return { kind: "unknown", name: target };
  const resolved = resolveRefName(read, target);
  if (resolved.ambiguous || !resolved.ref)
    return { kind: "unknown", name: target };
  if (resolved.ref === "HEAD") return headRef(read, target);
  return classifyQualifiedRef(resolved.ref) ?? { kind: "other", name: target };
}

// The branch a symbolic HEAD names, or `unknown` when the branch cannot be read. The reported
// name is the one the refspec wrote, not the resolved branch, so a fork push keeps its text.
/**
 * @param {((args: string[]) => string | null) | null} read
 * @param {string} name
 * @returns {{ kind: string, name: string }}
 */
function headRef(read, name) {
  const branch = read ? currentBranch(read) : null;
  return branch ? { kind: "branch", name: branch } : { kind: "unknown", name };
}

// The kind of a fully qualified ref name, or null when the name is not one this observer reads
// as a tag, a branch, or some other ref.
/**
 * @param {string} ref
 * @returns {{ kind: string, name: string } | null}
 */
function classifyQualifiedRef(ref) {
  if (ref.startsWith("refs/tags/"))
    return { kind: "tag", name: ref.slice("refs/tags/".length) };
  if (ref.startsWith("refs/heads/"))
    return { kind: "branch", name: ref.slice("refs/heads/".length) };
  if (ref.startsWith("refs/")) return { kind: "other", name: ref };
  return null;
}

// The capability a push needs. A tag, a non-branch ref, an unknown ref, the default branch, a
// deletion, a force, and a bulk flag all need `pushMain`; otherwise every ref is a non-default
// branch and the push is `pushBranch`. A branch whose default state is unknown (`null`) is
// `pushBranch` for the organization — today's behavior — because the resolver's own push rule
// requires `isDefault === false` and so denies it for every other destination.
/**
 * @param {boolean} bulk
 * @param {import("./observation.mjs").ObservedRef[]} refs
 * @returns {string}
 */
function pushCapability(bulk, refs) {
  if (bulk) return "pushMain";
  if (refs.length === 0) return "pushBranch";
  if (!refs.every((ref) => ref.kind === "branch" && ref.isDefault !== true))
    return "pushMain";
  return "pushBranch";
}

/**
 * @param {string} capability
 * @param {{ destination: import("./observation.mjs").Destination | null, source: string }} destination
 * @param {import("./observation.mjs").ObservedRef[]} refs
 * @returns {string}
 */
function pushReason(capability, destination, refs) {
  const target = destination.destination
    ? `${destination.destination.owner}/${destination.destination.repo}`
    : "an unresolved destination";
  const names =
    refs.map((ref) => `${ref.kind}:${ref.name}`).join(", ") || "no named ref";
  return `a push to ${target} (${destination.source}) needing ${capability} for ${names}`;
}

// Whether a token is a URL git could reach, rather than a remote name or a local path.
/**
 * @param {string} word
 * @returns {boolean}
 */
function isUrlLike(word) {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(word)) return true;
  return /^(?:[^@/]+@)?[A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+:/.test(word);
}

/**
 * @param {((args: string[]) => string | null) | null} read
 * @param {string} candidate
 * @returns {boolean}
 */
function namesRemote(read, candidate) {
  if (!read) return false;
  const wanted = candidate.toLowerCase();
  return remoteNames(read).some((name) => name.toLowerCase() === wanted);
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
