// The command observer: one recognized-form parse of an untrusted shell command, joined to
// read-only git state, that answers "what is this command, and which repository does it
// reach". It replaces the whole-string write scan the gate used to carry with a structural
// observation that can name the destination and the refs.
//
// This module is the dispatcher: it reads the shell words, decides which program the command
// runs, and routes it to the two domain parsers. `lib/gitpush.mjs` owns the `git push`
// observation (git's global options, aliases, refspecs, and push configuration);
// `lib/ghcommand.mjs` owns the `gh` observation (verbs, argument reading, and the -R/--repo
// destination); `lib/shellscan.mjs` cuts the command text into commands and reads heredoc
// bodies; `lib/observation.mjs` owns the normalized shape both return; `lib/gitstate.mjs`
// is the only module that touches git. The observation is a guardrail input, not a grant: the
// operation, the ref text, -R/--repo, --head/--base, and everything inside a compound command
// come from the command, which is untrusted, and the destination comes from git state, which
// the same user can edit. The resolver (repo-standard scripts/agent-access.mjs) is what turns
// the observation into a verdict, and it treats a missing destination or an unresolved ref as
// a denial.
//
// Bounded forms only, and the bounds are the contract:
//   - one command. A compound command (unquoted `;`, `&`, `|`, or a newline) is observed
//     only when no segment looks like a governed write; otherwise the whole command is
//     `unsupported`, because a later segment is not parsed.
//   - a heredoc body is data, not commands: the shell feeds it to the command's standard
//     input. A quoted or escaped delimiter makes the body literal; an unquoted delimiter
//     still expands command substitutions, so `$(...)` and backticks inside it are read out
//     and observed as the commands they run. A `<<`/`<<-` this observer cannot read (no
//     delimiter, an unclosed quote, a dynamic delimiter, a body with no terminator line) is
//     `unsupported`, so it fails closed.
//   - the program word is the first word (after leading NAME=value assignments and, under
//     PowerShell, one leading call operator `&`). A wrapper or interpreter (`bash -c`, `iex`,
//     `Start-Process`, `xargs`, an alias) is not a modeled form: the program is the wrapper,
//     so the command is `local`. That is a documented limit, not a claim of coverage.
//   - quoted text is not a program word: `echo "gh pr create"`, a commit message that
//     mentions a write, and a pipeline whose later segment only mentions one are `local`.
//   - a redirection is not an argument: `2>&1`, `> out.txt`, and `&>log` are shell syntax,
//     so the words a program classifier reads exclude them and their targets. Quoted text
//     that looks like one (`"2>&1"`) is a literal argument. A shape the reader cannot take
//     stays an argument, which leaves the observation as strict as it was.

import { isRepositoryEnvironmentName } from "./environment.mjs";
import { ghCommandStart } from "./ghargv.mjs";
import { classifyGh, ghOperation } from "./ghcommand.mjs";
import { gitGlobalOptions } from "./gitflags.mjs";
import { classifyGit, governedAlias } from "./gitpush.mjs";
import { commandReader, memoize } from "./gitstate.mjs";
import { localObservation, unsupported } from "./observation.mjs";
import { programName, readShellWord } from "./program.mjs";
import { splitCommands } from "./shellscan.mjs";

// Observe one shell command. `git` is the injected, read-only git port: `(args) => stdout
// or null`. `env` is the injected snapshot of the destination-changing environment variable
// *names* that are set (lib/environment.mjs): a governed write observed with one set is
// refused by the gate, because the command's own directory would not describe the repository
// it reaches. Everything else is derived here, so the same command, the same git state, and
// the same environment snapshot give the same observation.
/**
 * @param {string} command the shell text the agent asked to run
 * @param {{ cwd?: string | null, shell?: "bash" | "powershell", git?: ((args: string[]) => string | null) | null, env?: string[] }} [options]
 * @returns {import("./observation.mjs").Observation}
 */
export function observeCommand(command, options = {}) {
  const shell = options.shell === "powershell" ? "powershell" : "bash";
  const cwd =
    typeof options.cwd === "string" && options.cwd.length > 0
      ? options.cwd
      : null;
  const port = typeof options.git === "function" ? options.git : null;
  const context = { shell, cwd, memo: port ? memoize(port) : null };
  const environment = Array.isArray(options.env) ? [...options.env] : [];

  const text = typeof command === "string" ? command : "";
  const split = splitCommands(text, shell);
  if (split.unsupported)
    return {
      ...unsupported(split.unsupported),
      environment,
      ghWriteSignal: split.segments.some((segment) =>
        hasGhWriteShape(segment, shell),
      ),
    };
  const segments = split.segments.filter(
    (segment) => segment.trim().length > 0,
  );
  if (segments.length === 0)
    return { ...localObservation("an empty command"), environment };
  if (segments.length > 1) {
    if (segments.some((segment) => isGovernedShape(segment, context)))
      return {
        ...unsupported(
          "a compound command containing a governed write is not observed as separate commands",
        ),
        environment,
        ghWriteSignal: segments.some((segment) =>
          hasGhWriteShape(segment, shell),
        ),
      };
    return {
      ...localObservation("a compound command with no governed write"),
      environment,
    };
  }
  return { ...classifySegment(segments[0], context), environment };
}

// The intent object the repo-standard resolver validates (decideTarget). Only the fields the
// resolver names are sent, so a caller cannot word a grant out of an observation.
/**
 * @param {import("./observation.mjs").Observation} observation
 * @returns {Record<string, unknown>}
 */
export function toResolverIntent(observation) {
  const intent = {
    operation: observation.operation,
    capability: observation.capability,
    readOnly: observation.readOnly,
    resolved: observation.resolved,
    refs: observation.refs,
    force: observation.force,
    delete: observation.delete,
  };
  if (observation.base) intent.base = observation.base;
  if (observation.head) intent.head = observation.head;
  return intent;
}

// The destination and host to pass to the resolver, or null when the observer could not name
// one. A governed write with no destination is denied by the caller before the resolver runs,
// because a missing destination is not "no repository" but "unknown repository".
/**
 * @param {import("./observation.mjs").Observation} observation
 * @returns {{ host: string, destination: string } | null}
 */
export function observationDestination(observation) {
  const target = observation.destination;
  if (!target) return null;
  return { host: target.host, destination: `${target.owner}/${target.repo}` };
}

// One command, classified. The program word decides, and nothing else in the command can
// change the program.
/**
 * @param {string} segment
 * @param {{ shell: "bash" | "powershell", cwd: string | null, memo: ((args: string[]) => string | null) | null }} context
 * @returns {import("./observation.mjs").Observation}
 */
function classifySegment(segment, context) {
  const parsed = wordsAfterProgram(segment, context.shell);
  if (!parsed)
    return unsupported("the command's program word could not be read");
  const assignment = repositoryAssignments(parsed.assignments);
  if (assignment) {
    const result = unsupported(assignment);
    result.ghHostAssignment =
      parsed.program === "gh" &&
      parsed.assignments.some(
        (value) => value.split("=", 1)[0].toUpperCase() === "GH_HOST",
      );
    result.ghWriteSignal =
      parsed.program === "gh" && ghIsWrite(parsed.words, parsed.literals);
    return result;
  }
  if (parsed.program === "gh")
    return classifyGh(parsed.words, context, parsed.literals);
  if (parsed.program === "git") return classifyGit(parsed.words, context);
  return localObservation(`the program "${parsed.program}" is not git or gh`);
}

// Whether one segment of a compound command looks like a governed write. It shares the
// classifiers with the single-command path, so a form the observer calls a write is a write
// here too.
/**
 * @param {string} segment
 * @param {{ shell: "bash" | "powershell", cwd: string | null, memo: ((args: string[]) => string | null) | null }} context
 * @returns {boolean}
 */
function isGovernedShape(segment, context) {
  const parsed = wordsAfterProgram(segment, context.shell);
  if (!parsed) return false;
  if (parsed.program === "gh") {
    const started = ghCommandStart(parsed.words);
    if (started.help) return false;
    return (
      ghOperation(parsed.words, started.index, undefined, parsed.literals)
        .capability !== null
    );
  }
  if (parsed.program !== "git") return false;
  const globals = gitGlobalOptions(parsed.words);
  // An unmodeled git global option hides the subcommand. A `push` token anywhere in the
  // command is then enough to treat the segment as a potential governed write, which is the
  // conservative reading of a form this observer does not parse.
  if (globals === null) return parsed.words.includes("push");
  if (globals.subcommand === "push") return true;
  return (
    governedAlias(
      commandReader(context, globals.globalArgs),
      globals.subcommand,
    ) !== null
  );
}

/** @param {string} segment @param {"bash" | "powershell"} shell */
function hasGhWriteShape(segment, shell) {
  const parsed = wordsAfterProgram(segment, shell);
  return parsed?.program === "gh" && ghIsWrite(parsed.words, parsed.literals);
}

function ghIsWrite(words, literals) {
  const started = ghCommandStart(words);
  return (
    !started.help &&
    ghOperation(words, started.index, undefined, literals).capability !== null
  );
}

// The program word, the words after it, whether each of those words is literal text, and any
// leading NAME=value assignments. The program is read from the first word that is not an
// assignment, so an environment prefix does not hide which program runs.
/**
 * @param {string} text
 * @param {"bash" | "powershell"} shell
 * @returns {{ program: string, words: string[], literals: boolean[], assignments: string[] } | null}
 */
function wordsAfterProgram(text, shell) {
  let value = text.trim();
  if (shell === "powershell") value = value.replace(/^&(?=\s)\s*/, "");
  const tokens = tokenize(value, shell);
  if (tokens.length === 0) return null;
  const assignments = [];
  let index = 0;
  while (index < tokens.length && isAssignment(tokens[index].word)) {
    assignments.push(tokens[index].word);
    index += 1;
  }
  if (index >= tokens.length) return null;
  const rest = tokens.slice(index + 1);
  return {
    program: programName(tokens[index].word),
    words: rest.map((token) => token.word),
    literals: rest.map((token) => token.literal),
    assignments,
  };
}

/**
 * @param {string} word
 * @returns {boolean}
 */
function isAssignment(word) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

// The reason a command with an assignment prefix is not observed, or null when the prefix
// cannot change which repository is read.
/**
 * @param {string[]} assignments
 * @returns {string | null}
 */
function repositoryAssignments(assignments) {
  const found = assignments.find((assignment) =>
    isRepositoryEnvironmentName(assignment.split("=")[0]),
  );
  return found
    ? `the environment prefix "${found.split("=")[0]}" changes which repository is used`
    : null;
}

// The shell words of a command, read in the shell's own dialect, with whether each is literal.
// A word the reader cannot take (an unquoted $, backtick, or parenthesis) is kept as typed and
// marked non-literal, so a push with a variable in it is still seen as a push, and the program
// word is the one the shell would run. Redirections and their targets are shell syntax, not
// arguments, so they are dropped here: a classifier that reads `git push origin feat/x 2>&1`
// must not see `2>&1` as a refspec.
/**
 * @param {string} command
 * @param {"bash" | "powershell"} shell
 * @returns {Array<{ word: string, literal: boolean }>}
 */
function tokenize(command, shell) {
  const tokens = [];
  let index = 0;
  let target = false;
  while (index < command.length) {
    if (/\s/.test(command[index])) {
      index += 1;
      continue;
    }
    const token = readToken(command, index, shell);
    const redirection = target ? null : redirectionAt(command, index);
    if (!target && !redirection && token.word)
      tokens.push({ word: token.word, literal: token.literal });
    target = redirection ? !redirection.attached : false;
    index = Math.max(token.end, index + 1);
  }
  return tokens;
}

// One shell word at `index`, the index just past it, and whether it is literal. A word the
// reader cannot take is kept as typed and marked non-literal.
/**
 * @param {string} command
 * @param {number} index
 * @param {"bash" | "powershell"} shell
 * @returns {{ word: string, end: number, literal: boolean }}
 */
function readToken(command, index, shell) {
  const read = readShellWord(command, index, shell);
  const fallback = command.slice(index).match(/^\S+/)?.[0] ?? "";
  return {
    word: read ? read.word : fallback,
    end: read ? read.end : index + fallback.length,
    literal: read ? read.literal : false,
  };
}

// The redirection that starts a word at `index`, or null when the word is an argument. The
// target is attached (`2>&1`, `>file`) or the next word (`> file`, `2> file`). `<<` and `<<<`
// are not read here: a heredoc is lib/shellscan.mjs's, and keeping it as a word leaves the
// existing handling unchanged. A shape this cannot read is null, so the word stays an
// argument and the push stays as strict as it was.
/**
 * @param {string} text
 * @param {number} index
 * @returns {{ attached: boolean } | null}
 */
function redirectionAt(text, index) {
  let cursor = index;
  while (/[0-9]/.test(text[cursor] ?? "")) cursor += 1;
  const operator = redirectionOperator(text, cursor);
  if (!operator) return null;
  const next = cursor + operator.length;
  return { attached: next < text.length && !/\s/.test(text[next]) };
}

// The redirection operator at `at`: `&>`, `&>>`, `>`, `>>`, `<`, `>&`, or `<&`, or null for
// anything else. A file-descriptor prefix is read by the caller, so `2>&1` reaches this as
// `>&`. A `>&` with no descriptor after it is not a form this reader takes.
/**
 * @param {string} text
 * @param {number} at
 * @returns {string | null}
 */
function redirectionOperator(text, at) {
  const char = text[at];
  if (char === "&") {
    if (text[at + 1] !== ">") return null;
    return text[at + 2] === ">" ? "&>>" : "&>";
  }
  if (char !== ">" && char !== "<") return null;
  if (text[at + 1] === char) {
    return char === "<" ? null : ">>";
  }
  if (text[at + 1] !== "&") return char;
  return isDescriptor(text[at + 2]) ? `${char}&` : null;
}

/**
 * @param {string | undefined} char
 * @returns {boolean}
 */
function isDescriptor(char) {
  return char === "-" || /[0-9]/.test(char ?? "");
}
