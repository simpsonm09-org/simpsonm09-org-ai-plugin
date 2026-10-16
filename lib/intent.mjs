// The command observer: one recognized-form parse of an untrusted shell command, joined to
// read-only git state, that answers "what is this command, and which repository does it
// reach". It replaces the whole-string write scan the gate used to carry with a structural
// observation that can name the destination and the refs.
//
// This module is the dispatcher: it reads the shell words, decides which program the command
// runs, and routes it to the two domain parsers. `lib/gitpush.mjs` owns the `git push`
// observation (git's global options, aliases, refspecs, and push configuration);
// `lib/ghcommand.mjs` owns the `gh` observation (verbs, argument reading, and the -R/--repo
// destination); `lib/observation.mjs` owns the normalized shape both return; `lib/gitstate.mjs`
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

import { isRepositoryEnvironmentName } from "./environment.mjs";
import { classifyGh, ghCommandStart, ghOperation } from "./ghcommand.mjs";
import { classifyGit, gitGlobalOptions, governedAlias } from "./gitpush.mjs";
import { commandReader, memoize } from "./gitstate.mjs";
import { localObservation, unsupported } from "./observation.mjs";
import { programName, readShellWord } from "./program.mjs";

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
    return { ...unsupported(split.unsupported), environment };
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
  if (assignment) return unsupported(assignment);
  if (parsed.program === "gh") return classifyGh(parsed.words, context);
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
    return ghOperation(parsed.words, started.index).capability !== null;
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

// The program word, the words after it, and any leading NAME=value assignments. The program
// is read from the first word that is not an assignment, so an environment prefix does not
// hide which program runs.
/**
 * @param {string} text
 * @param {"bash" | "powershell"} shell
 * @returns {{ program: string, words: string[], assignments: string[] } | null}
 */
function wordsAfterProgram(text, shell) {
  let value = text.trim();
  if (shell === "powershell") value = value.replace(/^&(?=\s)\s*/, "");
  const words = tokenize(value, shell);
  if (words.length === 0) return null;
  const assignments = [];
  let index = 0;
  while (index < words.length && isAssignment(words[index])) {
    assignments.push(words[index]);
    index += 1;
  }
  if (index >= words.length) return null;
  return {
    program: programName(words[index]),
    words: words.slice(index + 1),
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

// The shell words of a command, read in the shell's own dialect. A word the reader cannot
// take (an unquoted $, backtick, or parenthesis) is kept as typed, so a push with a variable
// in it is still seen as a push, and the program word is the one the shell would run.
/**
 * @param {string} command
 * @param {"bash" | "powershell"} shell
 * @returns {string[]}
 */
function tokenize(command, shell) {
  const words = [];
  let index = 0;
  while (index < command.length) {
    if (/\s/.test(command[index])) {
      index += 1;
      continue;
    }
    const read = readShellWord(command, index, shell);
    const fallback = command.slice(index).match(/^\S+/)?.[0] ?? "";
    const end = read ? read.end : index + fallback.length;
    const word = read ? read.word : fallback;
    if (word) words.push(word);
    index = Math.max(end, index + 1);
  }
  return words;
}

// The unquoted top-level commands of a shell text, and the heredocs it contains. Quotes are
// opaque, so a separator inside a quoted argument or in a later pipeline stage's pattern is not
// a separator. A redirection's `&` (`2>&1`, `&>`) stays inside its command. A heredoc body is
// skipped to its terminator line, so a body line that begins with `git` or `gh` is data; an
// unquoted body's command substitutions are read out and returned as segments, because the
// shell runs them.
/**
 * @param {string} text
 * @param {"bash" | "powershell"} shell
 * @param {number} [depth] the command-substitution nesting already entered
 * @returns {{ segments: string[], unsupported: string | null }}
 */
function splitCommands(text, shell, depth = 0) {
  /** One scan's state: the segments closed so far, the command being read, the open quote,
   * and the heredoc operators whose bodies follow the next newline. */
  const state = {
    segments: [],
    current: "",
    quote: null,
    pending: [],
  };
  for (let index = 0; index < text.length; index += 1) {
    const step = scanTopLevel(text, index, shell, depth, state);
    if (step.unsupported)
      return {
        segments: [...state.segments, state.current],
        unsupported: step.unsupported,
      };
    index = step.index;
  }
  if (state.pending.length > 0)
    return {
      segments: [...state.segments, state.current],
      unsupported: `the heredoc delimiter "${state.pending[0].delimiter}" has no terminator line`,
    };
  state.segments.push(state.current);
  return { segments: state.segments, unsupported: null };
}

// Read the one top-level construct at `index`: a span that consumes several characters (a
// quote, an escape, an arithmetic expansion, a heredoc operator, a separator), or a single
// character of command text. The returned `index` is the last character the construct used,
// so the caller's loop step lands on the next one.
/**
 * @param {string} text
 * @param {number} index
 * @param {"bash" | "powershell"} shell
 * @param {number} depth
 * @param {{ segments: string[], current: string, quote: string | null, pending: HeredocSpec[] }} state
 * @returns {{ index: number, unsupported?: string }}
 */
function scanTopLevel(text, index, shell, depth, state) {
  const bash = shell === "bash";
  const char = text[index];
  if (state.quote) return scanQuoted(text, index, bash, state);
  if (char === "'" || char === '"') {
    state.quote = char;
    state.current += char;
    return { index };
  }
  if (bash && char === "\\" && index + 1 < text.length) {
    state.current += char + text[index + 1];
    return { index: index + 1 };
  }
  const arithmetic = readArithmeticAt(text, index, bash);
  if (arithmetic) return applyArithmetic(text, index, arithmetic, state);
  const heredoc = readTopLevelHeredoc(text, index, bash);
  if (heredoc) return applyHeredoc(text, index, heredoc, state);
  if (char === ";" || char === "\n" || char === "\r")
    return closeCommand(text, index, char, state, shell, depth);
  if (char === "&" || char === "|")
    return closeSegment(text, index, char, state);
  state.current += char;
  return { index };
}

// One character inside an open quote. A backslash escape in a Bash double quote, and a
// backtick escape in PowerShell, consume the next character; a doubled PowerShell quote is
// one quote; any other instance of the opening character closes the quote.
/**
 * @param {string} text
 * @param {number} index
 * @param {boolean} bash
 * @param {{ current: string, quote: string | null }} state
 * @returns {{ index: number }}
 */
function scanQuoted(text, index, bash, state) {
  const char = text[index];
  const quote = state.quote;
  state.current += char;
  const escaped =
    (bash && char === "\\" && quote === '"') || (!bash && char === "`");
  if (escaped && index + 1 < text.length) {
    state.current += text[index + 1];
    return { index: index + 1 };
  }
  if (char !== quote) return { index };
  if (!bash && text[index + 1] === quote) {
    state.current += text[index + 1];
    return { index: index + 1 };
  }
  state.quote = null;
  return { index };
}

// An unquoted `$((` is arithmetic expansion; a `<<` inside it is a shift, not a heredoc, so
// the whole expansion is taken as one span and never scanned for heredoc operators.
/**
 * @param {string} text
 * @param {number} index
 * @param {boolean} bash
 * @returns {{ end: number } | { unsupported: string } | null}
 */
function readArithmeticAt(text, index, bash) {
  if (
    !bash ||
    text[index] !== "$" ||
    text[index + 1] !== "(" ||
    text[index + 2] !== "("
  )
    return null;
  const end = matchingParen(text, index + 1);
  return end === null
    ? { unsupported: "an arithmetic expansion was not closed" }
    : { end };
}

/**
 * @param {string} text
 * @param {number} index
 * @param {{ end: number }} arithmetic
 * @param {{ current: string }} state
 * @returns {{ index: number }}
 */
function applyArithmetic(text, index, arithmetic, state) {
  if (arithmetic.unsupported)
    return { index, unsupported: arithmetic.unsupported };
  state.current += text.slice(index, arithmetic.end);
  return { index: arithmetic.end - 1 };
}

// The `<<` operator at `index` when it opens a heredoc, or null when the `<<` is part of a
// `<<<` here-string or a `<<` shift.
/**
 * @param {string} text
 * @param {number} index
 * @param {boolean} bash
 * @returns {{ end: number, spec: HeredocSpec } | { unsupported: string } | null}
 */
function readTopLevelHeredoc(text, index, bash) {
  if (
    !bash ||
    text[index] !== "<" ||
    text[index + 1] !== "<" ||
    text[index - 1] === "<" ||
    text[index + 2] === "<"
  )
    return null;
  return readHeredocOperator(text, index);
}

/**
 * @param {string} text
 * @param {number} index
 * @param {{ end: number, spec: HeredocSpec } | { unsupported: string }} heredoc
 * @param {{ current: string, pending: HeredocSpec[] }} state
 * @returns {{ index: number, unsupported?: string }}
 */
function applyHeredoc(text, index, heredoc, state) {
  if (heredoc.unsupported) return { index, unsupported: heredoc.unsupported };
  state.pending.push(heredoc.spec);
  state.current += text.slice(index, heredoc.end);
  return { index: heredoc.end - 1 };
}

// Close the command at a separator. A newline also opens the bodies of the heredocs still
// waiting, because the shell reads them from the lines that follow.
/**
 * @param {string} text
 * @param {number} index
 * @param {string} char
 * @param {{ segments: string[], current: string, pending: HeredocSpec[] }} state
 * @param {"bash" | "powershell"} shell
 * @param {number} depth
 * @returns {{ index: number, unsupported?: string }}
 */
function closeCommand(text, index, char, state, shell, depth) {
  state.segments.push(state.current);
  state.current = "";
  if (state.pending.length === 0 || char !== "\n") return { index };
  const bodies = readHeredocBodies(
    text,
    index + 1,
    state.pending,
    shell,
    depth,
  );
  if (bodies.unsupported) return { index, unsupported: bodies.unsupported };
  state.segments.push(...bodies.segments);
  state.pending = [];
  return { index: bodies.end - 1 };
}

// Close the command at `&` or `|`, unless the `&` is a redirection's (`2>&1`, `&>`), which
// stays in its command. A run of `&&`/`||` is one separator.
/**
 * @param {string} text
 * @param {number} index
 * @param {string} char
 * @param {{ segments: string[], current: string }} state
 * @returns {{ index: number }}
 */
function closeSegment(text, index, char, state) {
  if (char === "&" && isRedirectionAmp(text, index, state.current)) {
    state.current += char;
    return { index };
  }
  state.segments.push(state.current);
  state.current = "";
  return { index: skipRepeatedSeparators(text, index) };
}

/**
 * @param {string} text
 * @param {number} index
 * @param {string} current
 * @returns {boolean}
 */
function isRedirectionAmp(text, index, current) {
  const before = current.trimEnd().slice(-1);
  return text[index + 1] === ">" || before === ">" || before === "<";
}

/**
 * @param {string} text
 * @param {number} index
 * @returns {number}
 */
function skipRepeatedSeparators(text, index) {
  let cursor = index;
  while (
    cursor + 1 < text.length &&
    (text[cursor + 1] === "&" || text[cursor + 1] === "|")
  )
    cursor += 1;
  return cursor;
}

// One heredoc operator the scanner found: where its delimiter word ends, the delimiter the
// terminator line must equal, whether the body is literal (a quoted or escaped delimiter), and
// whether leading tabs are stripped (the `<<-` form).
/**
 * @typedef {{ delimiter: string, quoted: boolean, stripTabs: boolean }} HeredocSpec
 */

// Read a heredoc operator at `<<`. Returns its spec and the index just past the delimiter word,
// `{ unsupported }` for a `<<` that is meant as a heredoc but cannot be read safely, or null
// when this `<<` is not a heredoc at all (a here-string, or an arithmetic shift inside `(( ))`
// where the next token after the delimiter is a `)`).
/**
 * @param {string} text
 * @param {number} index the index of the first `<`
 * @returns {{ end: number, spec: HeredocSpec } | { unsupported: string } | null}
 */
function readHeredocOperator(text, index) {
  const open = heredocDelimiterStart(text, index);
  const word = readHeredocDelimiterWord(text, open.cursor);
  if (word.unsupported) return { unsupported: word.unsupported };
  if (!word.read || word.delimiter.length === 0)
    return { unsupported: "a heredoc has no delimiter" };
  // bash does not expand the delimiter word. This observer does not model a literal `$` or
  // backtick in a delimiter, so it refuses rather than compare the wrong terminator line.
  if (!word.quoted && /[$`]/.test(word.delimiter))
    return {
      unsupported: "a heredoc delimiter contains an unmodeled expansion",
    };
  if (!heredocFollows(text, word.cursor)) return null;
  return {
    end: word.cursor,
    spec: {
      delimiter: word.delimiter,
      quoted: word.quoted,
      stripTabs: open.stripTabs,
    },
  };
}

// The delimiter word's start: past `<<`, the `-` of a tab-stripping `<<-`, and the spaces or
// tabs bash allows before the word.
/**
 * @param {string} text
 * @param {number} index the index of the first `<`
 * @returns {{ cursor: number, stripTabs: boolean }}
 */
function heredocDelimiterStart(text, index) {
  let cursor = index + 2;
  let stripTabs = false;
  if (text[cursor] === "-") {
    stripTabs = true;
    cursor += 1;
  }
  while (
    cursor < text.length &&
    (text[cursor] === " " || text[cursor] === "\t")
  )
    cursor += 1;
  return { cursor, stripTabs };
}

// The delimiter word from `start` to the first character that cannot be part of it. A quoted
// piece is literal and marks the body literal; an escaped character is literal too.
/**
 * @param {string} text
 * @param {number} start
 * @returns {{ delimiter: string, quoted: boolean, cursor: number, read: boolean } | { unsupported: string }}
 */
function readHeredocDelimiterWord(text, start) {
  let cursor = start;
  let delimiter = "";
  let quoted = false;
  let read = false;
  while (cursor < text.length) {
    const char = text[cursor];
    if (/[\s;&|<>()]/.test(char)) break;
    read = true;
    if (char === "'" || char === '"') {
      const end = closingQuote(text, cursor, char);
      if (end === null)
        return { unsupported: "a heredoc delimiter quote is not closed" };
      delimiter += text.slice(cursor + 1, end);
      quoted = true;
      cursor = end + 1;
      continue;
    }
    if (char === "\\") {
      if (cursor + 1 >= text.length)
        return { unsupported: "a heredoc delimiter escape is not closed" };
      delimiter += text[cursor + 1];
      quoted = true;
      cursor += 2;
      continue;
    }
    delimiter += char;
    cursor += 1;
  }
  return { delimiter, quoted, cursor, read };
}

// Whether the delimiter word ends the command line or is followed by more of it. bash reads
// only a whole word as the delimiter, so `<<EOFx` is not a heredoc this observer can read.
/**
 * @param {string} text
 * @param {number} cursor
 * @returns {boolean}
 */
function heredocFollows(text, cursor) {
  const after = text[cursor];
  return after === undefined || /\s/.test(after) || "; &|><".includes(after);
}

// The index of the closing quote for a quote opened at `start`, or null when it is not closed.
/**
 * @param {string} text
 * @param {number} start
 * @param {string} quote
 * @returns {number | null}
 */
function closingQuote(text, start, quote) {
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && quote === '"') {
      index += 1;
      continue;
    }
    if (char === quote) return index;
  }
  return null;
}

// The index just past the `)` that closes the `(` at `start`, counting nested parentheses and
// skipping quoted spans, or null when it is not closed.
/**
 * @param {string} text
 * @param {number} start the index of the opening `(`
 * @returns {number | null}
 */
function matchingParen(text, start) {
  let depth = 0;
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === "'" || char === '"') {
      const close = closingQuote(text, index, char);
      index = close === null ? text.length : close + 1;
      continue;
    }
    index += 1;
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
}

// Skip the heredoc bodies of one command line. Each pending spec reads its own body up to its
// terminator line; a body with no terminator, or an unquoted body whose command substitution is
// not closed or nests too deeply, is `unsupported`. An unquoted body's substitutions are
// recursively split, so a governed write inside one is observed as the write it runs.
/**
 * @param {string} text
 * @param {number} start the index just after the newline that opened the bodies
 * @param {HeredocSpec[]} pending
 * @param {"bash" | "powershell"} shell
 * @param {number} depth
 * @returns {{ segments: string[], end: number, unsupported: string | null }}
 */
function readHeredocBodies(text, start, pending, shell, depth) {
  let cursor = start;
  const segments = [];
  for (const spec of pending) {
    const body = readHeredocBody(text, cursor, spec, shell, depth, segments);
    if (body.unsupported)
      return { segments, end: cursor, unsupported: body.unsupported };
    cursor = body.end;
  }
  return { segments, end: cursor, unsupported: null };
}

// One heredoc body, from `start` to the line just past its terminator. Each line is compared
// to the delimiter before anything else; a line that is not the terminator is body text, and
// an unquoted body's command substitutions are read out into `out`.
/**
 * @param {string} text
 * @param {number} start
 * @param {HeredocSpec} spec
 * @param {"bash" | "powershell"} shell
 * @param {number} depth
 * @param {string[]} out the segments the caller collects
 * @returns {{ end: number, unsupported?: string }}
 */
function readHeredocBody(text, start, spec, shell, depth, out) {
  let cursor = start;
  while (cursor <= text.length) {
    const newline = text.indexOf("\n", cursor);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(cursor, lineEnd).replace(/\r$/, "");
    if (matchesHeredocDelimiter(line, spec))
      return { end: newline === -1 ? text.length : newline + 1 };
    const failed = readBodyLineCommands(line, spec, shell, depth, out);
    if (failed) return { end: cursor, unsupported: failed };
    if (newline === -1) break;
    cursor = newline + 1;
  }
  return {
    end: cursor,
    unsupported: `the heredoc delimiter "${spec.delimiter}" has no terminator line`,
  };
}

/**
 * @param {string} line
 * @param {HeredocSpec} spec
 * @returns {boolean}
 */
function matchesHeredocDelimiter(line, spec) {
  const compare = spec.stripTabs ? line.replace(/^\t+/, "") : line;
  return compare === spec.delimiter;
}

// The command substitutions one unquoted body line runs, appended to `out` as segments. A
// quoted body is literal, so it has none. Returns the reason a substitution cannot be read,
// or null.
/**
 * @param {string} line
 * @param {HeredocSpec} spec
 * @param {"bash" | "powershell"} shell
 * @param {number} depth
 * @param {string[]} out
 * @returns {string | null}
 */
function readBodyLineCommands(line, spec, shell, depth, out) {
  if (spec.quoted) return null;
  if (depth >= 8) return "a command substitution is nested too deeply";
  const substitutions = readSubstitutions(line);
  if (substitutions.unsupported) return substitutions.unsupported;
  for (const content of substitutions.commands) {
    const inner = splitCommands(content, shell, depth + 1);
    if (inner.unsupported) return inner.unsupported;
    out.push(...inner.segments);
  }
  return null;
}

// The command substitutions a shell text carries: the inner text of each `$(...)` and each
// backtick pair. A substitution that is not closed is `unsupported`.
/**
 * @param {string} text
 * @returns {{ commands: string[] } | { unsupported: string }}
 */
function readSubstitutions(text) {
  const commands = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && index + 1 < text.length) {
      index += 1;
      continue;
    }
    if (char === "$" && text[index + 1] === "(") {
      const end = matchingParen(text, index + 1);
      if (end === null)
        return { unsupported: "a command substitution is not closed" };
      commands.push(text.slice(index + 2, end - 1));
      index = end - 1;
      continue;
    }
    if (char === "`") {
      const end = nextBacktick(text, index + 1);
      if (end === -1)
        return { unsupported: "a backtick command substitution is not closed" };
      commands.push(text.slice(index + 1, end));
      index = end;
    }
  }
  return { commands };
}

// The next unescaped backtick after `start`, or -1.
/**
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
function nextBacktick(text, start) {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === "`") return index;
  }
  return -1;
}
