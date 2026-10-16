// The `gh` half of the command observer: the verb table, the argument grammar, and the
// destination from `-R`/`--repo` or the clone's own remotes. It reads git state through the
// injected read-only reader (lib/gitstate.mjs) and returns the shared Observation shape
// (lib/observation.mjs).
//
// One left-to-right argument read is the whole grammar (`readGhArguments`). Every option that
// takes a value consumes its value, whether it is attached (`-Rvalue`, `-R=value`, `--repo=value`)
// or the next word, so a value that begins with the text of another flag — `gh pr create --title
// -Rsimpsonm09-org/demo-repo`, where pflag hands `-Rsimpsonm09-org/demo-repo` to `--title` — can
// never be read as that flag. An option the per-command table does not name makes the read
// untrustworthy: the observer then refuses to name a destination instead of guessing one, so a
// governed write resolves to `resolved:false` and the resolver denies it.
//
// Bounded forms only, and the bounds are the contract:
//   - `gh` global flags are -R/--repo, --help, and --version; a gh verb with no precise
//     capability in this observer is a conservative `admin` write, never a read.
//   - `gh` resolves a missing -R through the API, so a clone that names more than one github
//     destination is `ambiguous` and a governed write fails closed.
//   - a wrapper, an interpreter, or an alias is not a modeled form: the program is the
//     wrapper, so the command is `local`.

import {
  commandReader,
  identityKey,
  parseGithubRepo,
  parseRepoArgument,
  remoteFetchUrl,
  remoteNames,
  remotePushUrls,
} from "./gitstate.mjs";
import {
  baseObservation,
  readObservation,
  writeObservation,
} from "./observation.mjs";

// A gh verb that only reads or only touches the local machine. These are the verbs the
// observer treats as read-only, and the list is deliberately small: a verb not on it is a
// write, so an unlisted verb can never be granted as a read.
const READ_VERBS = new Set([
  "list",
  "view",
  "status",
  "diff",
  "checks",
  "show",
  "watch",
  "clone",
  "checkout",
  "download",
  "browse",
  "get",
]);

// A gh group whose verbs are all reads (`gh search prs`, `gh status`). Kept beside the read
// verbs so a group-wide read is one entry rather than an enumeration of its verbs.
const READ_GROUPS = new Set(["search", "status"]);

// A gh group that does not write to a repository at all (its state is local config or the
// terminal). Anything outside this set and outside the reads above is treated as a write.
const LOCAL_GROUPS = new Set([
  "alias",
  "auth",
  "completion",
  "config",
  "extension",
  "help",
  "version",
]);

// The gh subcommands that change repository state, matching the resolver's own table.
const ADMIN_VERBS = {
  release: ["create", "edit", "delete", "upload"],
  workflow: ["run", "enable", "disable"],
  secret: ["set", "delete"],
  repo: ["create", "delete", "edit", "rename", "transfer", "archive"],
};

// The gh `api` options that carry a request body, and so an implicit write.
const API_BODY_OPTIONS = ["-f", "-F", "--field", "--raw-field", "--input"];

// The generic option spellings every gh command inherits. `-R`/`--repo` is a persistent flag,
// so it is accepted before or after the subcommand; the help and version flags print and exit.
const GLOBAL_OPTIONS = optionSpec(
  ["-R", "--repo"],
  ["-h", "--help", "--version"],
);

// A gh option table, as the exact token spellings, split by whether the option takes a value.
// One table per modeled command is what makes the value/flag distinction authoritative: `-r` is
// `--reviewer` (a value) for `pr create` and `--rebase` (a flag) for `pr merge`, and a value
// option's value can never be read as a flag.
/**
 * @param {string[]} values the option spellings that take a value
 * @param {string[]} flags the option spellings that take none
 * @returns {{ values: Set<string>, flags: Set<string> }}
 */
function optionSpec(values, flags) {
  return { values: new Set(values), flags: new Set(flags) };
}

const READ_OPTION_VALUES = [
  "--json",
  "-q",
  "--jq",
  "--template",
  "-R",
  "--repo",
  "-L",
  "--limit",
  "-s",
  "--state",
  "-S",
  "--search",
  "-B",
  "--base",
  "-H",
  "--head",
  "-l",
  "--label",
  "-a",
  "--assignee",
  "-A",
  "--author",
  "-c",
  "--comments",
];

const COMMAND_OPTIONS = new Map([
  [
    "api",
    optionSpec(
      [
        "-X",
        "--method",
        "-f",
        "--raw-field",
        "-F",
        "--field",
        "--input",
        "-H",
        "--header",
        "-q",
        "--jq",
        "--template",
        "--cache",
        "--hostname",
        "--preview",
        "-R",
        "--repo",
      ],
      [
        "-i",
        "--include",
        "--paginate",
        "--slurp",
        "-s",
        "--silent",
        "--verbose",
        "-h",
        "--help",
      ],
    ),
  ],
  [
    "pr create",
    optionSpec(
      [
        "-t",
        "--title",
        "-b",
        "--body",
        "-F",
        "--body-file",
        "-B",
        "--base",
        "-H",
        "--head",
        "-r",
        "--reviewer",
        "-a",
        "--assignee",
        "-l",
        "--label",
        "-m",
        "--milestone",
        "-p",
        "--project",
        "-T",
        "--template",
        "--recover",
        "-R",
        "--repo",
      ],
      [
        "-d",
        "--draft",
        "-f",
        "--fill",
        "--fill-first",
        "--fill-verbose",
        "-w",
        "--web",
        "--maintainer-edit",
        "--no-maintainer-edit",
        "-h",
        "--help",
      ],
    ),
  ],
  [
    "pr merge",
    optionSpec(
      [
        "-b",
        "--body",
        "-t",
        "--subject",
        "-F",
        "--body-file",
        "--match-head-commit",
        "-R",
        "--repo",
      ],
      [
        "-m",
        "--merge",
        "-s",
        "--squash",
        "-r",
        "--rebase",
        "-d",
        "--delete-branch",
        "--auto",
        "--disable-auto",
        "--admin",
        "-h",
        "--help",
      ],
    ),
  ],
  [
    "release create",
    optionSpec(
      [
        "-n",
        "--notes",
        "-F",
        "--notes-file",
        "-t",
        "--title",
        "--target",
        "--notes-start-tag",
        "--discussion-category",
        "-R",
        "--repo",
      ],
      [
        "-d",
        "--draft",
        "-p",
        "--prerelease",
        "--generate-notes",
        "--latest",
        "--verify-tag",
        "--fail-on-no-commits",
        "-h",
        "--help",
      ],
    ),
  ],
  [
    "release edit",
    optionSpec(
      [
        "-n",
        "--notes",
        "-F",
        "--notes-file",
        "-t",
        "--title",
        "--tag",
        "--target",
        "-R",
        "--repo",
      ],
      ["-d", "--draft", "-p", "--prerelease", "--latest", "-h", "--help"],
    ),
  ],
  [
    "release delete",
    optionSpec(
      ["-R", "--repo"],
      ["-y", "--yes", "--cleanup-tag", "-h", "--help"],
    ),
  ],
  [
    "release upload",
    optionSpec(["-R", "--repo"], ["--clobber", "-h", "--help"]),
  ],
  [
    "workflow run",
    optionSpec(
      ["-f", "--raw-field", "--ref", "-R", "--repo"],
      ["-h", "--help"],
    ),
  ],
  [
    "secret set",
    optionSpec(
      [
        "-b",
        "--body",
        "-f",
        "--env-file",
        "-a",
        "--app",
        "-o",
        "--org",
        "-r",
        "--repos",
        "-v",
        "--visibility",
        "-e",
        "--env",
      ],
      ["-h", "--help"],
    ),
  ],
  [
    "secret delete",
    optionSpec(
      ["-a", "--app", "-o", "--org", "-r", "--repos", "-e", "--env"],
      ["-h", "--help"],
    ),
  ],
  [
    "repo create",
    optionSpec(
      [
        "-d",
        "--description",
        "--homepage",
        "-l",
        "--license",
        "--gitignore",
        "--template",
        "-t",
        "--team",
        "--source",
        "--remote",
      ],
      [
        "--public",
        "--private",
        "--internal",
        "--clone",
        "--disable-issues",
        "--disable-wiki",
        "--include-all-branches",
        "-y",
        "--confirm",
        "-h",
        "--help",
      ],
    ),
  ],
  [
    "repo edit",
    optionSpec(
      [
        "-d",
        "--description",
        "--homepage",
        "--add-topic",
        "--remove-topic",
        "--default-branch",
        "--visibility",
        "-R",
        "--repo",
      ],
      [
        "--enable-issues",
        "--disable-issues",
        "--enable-wiki",
        "--disable-wiki",
        "--enable-projects",
        "--disable-projects",
        "--enable-discussions",
        "--disable-discussions",
        "-h",
        "--help",
      ],
    ),
  ],
  [
    "repo delete",
    optionSpec(["-R", "--repo"], ["-y", "--yes", "-h", "--help"]),
  ],
  [
    "repo archive",
    optionSpec(["-R", "--repo"], ["-y", "--yes", "-h", "--help"]),
  ],
  [
    "repo rename",
    optionSpec(["-R", "--repo"], ["-y", "--yes", "-h", "--help"]),
  ],
  [
    "repo transfer",
    optionSpec(["-R", "--repo"], ["-y", "--yes", "-h", "--help"]),
  ],
]);

// The option table for a group and its verb. An unmodeled command gets the global table only,
// so any other option it carries makes the read untrustworthy and the destination unresolved.
/**
 * @param {string[]} words
 * @param {number} start
 * @returns {{ values: Set<string>, flags: Set<string> }}
 */
function optionSpecFor(words, start) {
  const group = words[start];
  const verb = words[start + 1];
  if (group === "api") return COMMAND_OPTIONS.get("api");
  const command = COMMAND_OPTIONS.get(`${group} ${verb}`);
  if (command) return command;
  if (READ_GROUPS.has(group) || READ_VERBS.has(verb))
    return READ_TABLE.get(group) ?? GLOBAL_OPTIONS;
  return GLOBAL_OPTIONS;
}

// The read verbs share one broad option table, so a real gh read with its usual flags keeps a
// trustworthy destination instead of falling out of the model.
const READ_TABLE = new Map([
  [
    "pr",
    optionSpec(READ_OPTION_VALUES, [
      "-w",
      "--web",
      "-d",
      "--draft",
      "--help",
      "-h",
    ]),
  ],
  ["issue", optionSpec(READ_OPTION_VALUES, ["-w", "--web", "--help", "-h"])],
  ["run", optionSpec(READ_OPTION_VALUES, ["-w", "--web", "--help", "-h"])],
  ["repo", optionSpec(READ_OPTION_VALUES, ["-w", "--web", "--help", "-h"])],
  ["release", optionSpec(READ_OPTION_VALUES, ["-w", "--web", "--help", "-h"])],
  ["workflow", optionSpec(READ_OPTION_VALUES, ["-w", "--web", "--help", "-h"])],
  [
    "search",
    optionSpec(
      [
        ...READ_OPTION_VALUES,
        "--language",
        "--created",
        "--updated",
        "--merged",
        "--owner",
        "--topic",
        "--match",
      ],
      ["-w", "--web", "--draft", "--archived", "--help", "-h"],
    ),
  ],
]);

// One gh command, classified. The `gh` program word decides, and nothing else in the command
// can change the program.
/**
 * @param {string[]} words the tokens after the `gh` program word
 * @param {{ shell: "bash" | "powershell", cwd: string | null, memo: ((args: string[]) => string | null) | null }} context
 * @returns {import("./observation.mjs").Observation}
 */
export function classifyGh(words, context) {
  const started = ghCommandStart(words);
  if (started.help)
    return readObservation("gh", "a gh help or version command");
  const scan = readGhArguments(
    words,
    started.index + 1,
    optionSpecFor(words, started.index),
  );
  const options = [...started.options, ...scan.options];
  const strict = started.strict && scan.strict;
  const operation = ghOperation(words, started.index, scan);
  const read = commandReader(context, []);
  const repo = ghRepoArgument(options);
  const destination = ghDestination(repo, strict, read, context);
  const resolved = destination.resolved;

  if (operation.capability === null) {
    const local = operation.operation === "local";
    return {
      ...baseObservation(local ? "local" : "read", "gh"),
      operation: local ? "none" : "read",
      readOnly: true,
      resolved,
      destination: destination.destination,
      destinationSource: destination.source,
      reason: operation.reason,
    };
  }

  const sides =
    operation.operation === "openPr"
      ? pullRequestSides(options)
      : { base: null, head: null, conflict: false };
  return writeObservation({
    program: "gh",
    operation: operation.operation,
    capability: operation.capability,
    resolved: resolved && !sides.conflict,
    destination: destination.destination,
    destinationSource: destination.source,
    refs: [],
    force: false,
    delete: false,
    base: sides.base,
    head: sides.head,
    reason: operation.reason,
  });
}

// The index of the gh subcommand, after the global flags, and whether the command is only
// asking for help. A global option this observer does not model stops the scan at that token
// and marks the read untrustworthy, so the unmodeled global is then read as the group and the
// conservative `admin` fallback applies.
/**
 * @param {string[]} words
 * @returns {{ index: number, help: boolean, strict: boolean, options: Array<{ name: string, value: string | null }> }}
 */
export function ghCommandStart(words) {
  const options = [];
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (word === "--help" || word === "-h" || word === "--version")
      return { index, help: true, strict: true, options };
    if (word.length < 2 || word[0] !== "-") break;
    const option = readOption(word, GLOBAL_OPTIONS);
    if (!option) return { index, help: false, strict: false, options };
    if (option.value === null && option.takesValue) {
      if (index + 1 >= words.length)
        return { index, help: false, strict: false, options };
      options.push({ name: option.name, value: words[index + 1] });
      index += 2;
      continue;
    }
    options.push({ name: option.name, value: option.value });
    index += 1;
  }
  return { index, help: false, strict: true, options };
}

// The operation and the capability one gh invocation needs. A read verb is a read; a group
// that never writes a repository is local; a known verb takes its precise capability; every
// other verb is a conservative `admin` write, so an unmodeled verb is never granted as a read.
/**
 * @param {string[]} words
 * @param {number} start
 * @param {{ options: Array<{ name: string, value: string | null }>, strict: boolean }} [scan]
 * @returns {{ operation: string, capability: string | null, reason: string }}
 */
export function ghOperation(words, start, scan) {
  const group = words[start];
  const verb = words[start + 1];
  if (group === undefined)
    return { operation: "read", capability: null, reason: "bare gh" };
  if (LOCAL_GROUPS.has(group))
    return {
      operation: "local",
      capability: null,
      reason: `the local gh group "${group}"`,
    };
  if (READ_GROUPS.has(group))
    return {
      operation: "read",
      capability: null,
      reason: `the gh read group "${group}"`,
    };
  if (READ_VERBS.has(verb))
    return {
      operation: "read",
      capability: null,
      reason: `the gh read verb "${group} ${verb}"`,
    };
  if (group === "api") {
    const argumentsScan =
      scan ?? readGhArguments(words, start + 1, optionSpecFor(words, start));
    return apiOperation(argumentsScan.options);
  }
  if (group === "pr" && verb === "create")
    return {
      operation: "openPr",
      capability: "openPr",
      reason: "gh pr create",
    };
  if (group === "pr" && verb === "merge")
    return {
      operation: "mergePr",
      capability: "mergePr",
      reason: "gh pr merge",
    };
  if (ADMIN_VERBS[group]?.includes(verb))
    return {
      operation: "admin",
      capability: "admin",
      reason: `the gh admin verb "${group} ${verb}"`,
    };
  return {
    operation: "admin",
    capability: "admin",
    reason: `the gh verb "${group} ${verb ?? ""}" has no precise capability; it is treated as an admin write`,
  };
}

// `gh api` reads only when the method is absent, GET, or HEAD, and the command carries no body
// option. The body options and the method come from the same left-to-right read, so a body flag
// that is really another option's value (`--jq -f`) is not read as a body. An unknown explicit
// method is a conservative write. A repeated method is read the way gh reads it, last one wins,
// so an earlier GET cannot hide a later DELETE.
/**
 * @param {Array<{ name: string, value: string | null }>} options
 * @returns {{ operation: string, capability: string | null, reason: string }}
 */
function apiOperation(options) {
  if (options.some((option) => API_BODY_OPTIONS.includes(option.name)))
    return {
      operation: "admin",
      capability: "admin",
      reason: "gh api with a request body",
    };
  const methods = options
    .filter((option) => option.name === "-X" || option.name === "--method")
    .map((option) => option.value);
  const method = methods.length > 0 ? methods[methods.length - 1] : null;
  if (method === null)
    return { operation: "read", capability: null, reason: "gh api read" };
  const upper = method.toUpperCase();
  if (upper === "GET" || upper === "HEAD")
    return { operation: "read", capability: null, reason: `gh api ${upper}` };
  return {
    operation: "admin",
    capability: "admin",
    reason: `gh api method ${upper} is a conservative write`,
  };
}

// One left-to-right read of a gh command's arguments from `start`. Each option that takes a
// value consumes it, attached or as the next word, and an option not in the table stops the
// read and marks it untrustworthy (`strict:false`). Everything before the stop is still a real
// argument, so an `-R` already taken stays authoritative; only the destination fallback is
// refused.
/**
 * @param {string[]} words
 * @param {number} start
 * @param {{ values: Set<string>, flags: Set<string> }} spec
 * @returns {{ options: Array<{ name: string, value: string | null }>, positionals: string[], strict: boolean }}
 */
function readGhArguments(words, start, spec) {
  const state = {
    options: [],
    positionals: [],
    strict: true,
    literal: false,
  };
  let index = start;
  while (index < words.length) {
    const extra = readGhToken(words, index, spec, state);
    if (!state.strict) break;
    index += 1 + extra;
  }
  return {
    options: state.options,
    positionals: state.positionals,
    strict: state.strict,
  };
}

// Read one argument token: a positional, or an option of `spec`, consuming the next word when
// a value option has no attached value. An option outside the table (or a value option at the
// end) stops the read trusted-so-far by clearing `strict`. Returns the number of extra tokens
// consumed (0 or 1).
/**
 * @param {string[]} words
 * @param {number} index
 * @param {{ values: Set<string>, flags: Set<string> }} spec
 * @param {{ options: Array<{ name: string, value: string | null }>, positionals: string[], strict: boolean, literal: boolean }} state
 * @returns {number}
 */
function readGhToken(words, index, spec, state) {
  const word = words[index];
  if (state.literal || word.length < 2 || word[0] !== "-") {
    state.positionals.push(word);
    return 0;
  }
  if (word === "--") {
    state.literal = true;
    return 0;
  }
  const option = readOption(word, spec);
  if (!option) {
    state.strict = false;
    return 0;
  }
  if (option.takesValue && option.value === null) {
    const next = words[index + 1];
    if (next === undefined) {
      state.strict = false;
      return 0;
    }
    state.options.push({ name: option.name, value: next });
    return 1;
  }
  state.options.push({ name: option.name, value: option.value });
  return 0;
}

// The value one option carries, in the only grammar gh's own parser (cobra/pflag) accepts:
// `--long value`, `--long=value`, `-s value`, `-svalue`, and `-s=value`. One helper for every
// option this observer reads — the API method, the API body options, the pull request sides,
// and the repository and global -R — so no two call sites can disagree about what gh accepts.
/**
 * @param {string} word
 * @param {{ values: Set<string>, flags: Set<string> }} spec
 * @returns {{ name: string, value: string | null, takesValue: boolean } | null} null when the
 *   word is not an option of this table; a null value on a value option means the value, if
 *   any, is the next word
 */
function readOption(word, spec) {
  if (word.startsWith("--")) return readLongOption(word, spec);
  return readShortOption(word, spec);
}

// A long option: `--name`, `--name=value`, or `--name value` for a value option. A boolean
// option is only valid in its bare spelling, so `--draft=x` is not this option.
/**
 * @param {string} word
 * @param {{ values: Set<string>, flags: Set<string> }} spec
 * @returns {{ name: string, value: string | null, takesValue: boolean } | null}
 */
function readLongOption(word, spec) {
  const equals = word.indexOf("=");
  const name = equals === -1 ? word : word.slice(0, equals);
  if (spec.values.has(name))
    return {
      name,
      value: equals === -1 ? null : word.slice(equals + 1),
      takesValue: true,
    };
  if (spec.flags.has(name) && equals === -1)
    return { name, value: null, takesValue: false };
  return null;
}

// A short option: `-s`, `-svalue`, or `-s=value` for a value option, and `-s` alone for a
// boolean. pflag has no bundling here, so only the first two characters name the option.
/**
 * @param {string} word
 * @param {{ values: Set<string>, flags: Set<string> }} spec
 * @returns {{ name: string, value: string | null, takesValue: boolean } | null}
 */
function readShortOption(word, spec) {
  const short = word.slice(0, 2);
  if (!spec.values.has(short)) {
    if (spec.flags.has(short) && word.length === 2)
      return { name: short, value: null, takesValue: false };
    return null;
  }
  if (word.length === 2) return { name: short, value: null, takesValue: true };
  const attached = word.slice(2);
  return {
    name: short,
    value: attached.startsWith("=") ? attached.slice(1) : attached,
    takesValue: true,
  };
}

// The -R/--repo argument, wherever it appears (a gh global flag or a command flag), with how
// many times it was given. More than one is ambiguous rather than a guess; the value is the
// last one, which is the one gh uses. Only occurrences the grammar read as the option count: a
// `-R`-looking value of another option is not in the list.
/**
 * @param {Array<{ name: string, value: string | null }>} options
 * @returns {{ value: string | null, count: number } | null}
 */
function ghRepoArgument(options) {
  const found = options.filter(
    (option) => option.name === "-R" || option.name === "--repo",
  );
  if (found.length === 0) return null;
  return { value: found[found.length - 1].value, count: found.length };
}

// Which repository a gh command reaches: the explicit -R/--repo, or the clone's own
// destination when git names exactly one. gh resolves a missing -R through the API (a fork's
// pull request targets its parent by default), so a clone with more than one github
// destination is ambiguous and a governed write fails closed. That is why the org's own
// working agreements say to always pass `-R <owner>/<repo>`. A read the grammar could not trust
// does not fall back to the clone: an option value could have been mistaken for a flag, so the
// destination is unresolved rather than guessed.
/**
 * @param {{ value: string | null, count: number } | null} repo
 * @param {boolean} strict
 * @param {((args: string[]) => string | null) | null} read
 * @param {{ cwd: string | null }} context
 * @returns {{ destination: import("./observation.mjs").Destination | null, resolved: boolean, source: import("./observation.mjs").Observation["destinationSource"] }}
 */
function ghDestination(repo, strict, read, context) {
  if (repo) {
    if (repo.count > 1)
      return { destination: null, resolved: false, source: "explicit" };
    const parsed = repo.value === null ? null : parseRepoArgument(repo.value);
    return {
      destination: parsed,
      resolved: parsed !== null,
      source: "explicit",
    };
  }
  if (!strict) return { destination: null, resolved: false, source: "none" };
  if (!context.cwd || !read)
    return { destination: null, resolved: false, source: "cwd" };
  const found = cwdDestinations(read);
  if (found.length === 1)
    return { destination: found[0], resolved: true, source: "cwd" };
  return { destination: null, resolved: false, source: "cwd" };
}

// Every distinct github destination the clone's remotes name. More than one is ambiguous.
/**
 * @param {(args: string[]) => string | null} read
 * @returns {import("./observation.mjs").Destination[]}
 */
function cwdDestinations(read) {
  const found = new Map();
  for (const name of remoteNames(read)) {
    const urls = new Set([
      ...remotePushUrls(read, name),
      remoteFetchUrl(read, name),
    ]);
    for (const url of urls) {
      if (!url) continue;
      const parsed = parseGithubRepo(url);
      if (parsed) found.set(identityKey(parsed), parsed);
    }
  }
  return [...found.values()];
}

// The pull request sides, from --base/-B and --head/-H. Only `pr create` reads them; an
// owner-qualified side that names an owner without a repository is kept owner-qualified so the
// resolver's same-repository test denies it. Two different values for one side are ambiguous:
// the conflict flag makes the observation unresolved rather than letting the first value stand
// for a side the command does not reach.
/**
 * @param {Array<{ name: string, value: string | null }>} options
 * @returns {{ base: import("./observation.mjs").ObservedSide | null, head: import("./observation.mjs").ObservedSide | null, conflict: boolean }}
 */
function pullRequestSides(options) {
  const base = sideValue(options, "-B", "--base");
  const head = sideValue(options, "-H", "--head");
  return {
    base: base.value === null ? null : sideOf(base.value),
    head: head.value === null ? null : sideOf(head.value),
    conflict: base.conflict || head.conflict,
  };
}

// One side's value: null when the option is absent, the single value when it is given once or
// with the same value, and a conflict when it is given two different values.
/**
 * @param {Array<{ name: string, value: string | null }>} options
 * @param {string} short
 * @param {string} long
 * @returns {{ value: string | null, conflict: boolean }}
 */
function sideValue(options, short, long) {
  const values = options
    .filter((option) => option.name === short || option.name === long)
    .map((option) => option.value)
    .filter((value) => value !== null);
  const distinct = [...new Set(values)];
  if (distinct.length === 0) return { value: null, conflict: false };
  if (distinct.length > 1) return { value: null, conflict: true };
  return { value: distinct[0], conflict: false };
}

/**
 * @param {string} value
 * @returns {import("./observation.mjs").ObservedSide | null}
 */
function sideOf(value) {
  if (value === null || value.length === 0) return null;
  const withRepo = /^([^/:\s]+)\/([^:\s]+):(.+)$/.exec(value);
  if (withRepo)
    return { owner: withRepo[1], repo: withRepo[2], branch: withRepo[3] };
  const ownerOnly = /^([^/:\s]+):(.+)$/.exec(value);
  if (ownerOnly)
    return { owner: ownerOnly[1], repo: null, branch: ownerOnly[2] };
  return { owner: null, repo: null, branch: value };
}
