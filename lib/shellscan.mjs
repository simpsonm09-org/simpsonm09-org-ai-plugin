// The top-level scanner: it cuts one shell text into the commands the shell would run and
// reads the heredoc bodies that follow the line. Separators inside quotes, inside an
// arithmetic expansion, or inside a redirection (`2>&1`, `&>`) are not separators; a heredoc
// body is data up to its terminator line, except that an unquoted body's command
// substitutions run, so they are read out as segments too. The lexical forms it keeps whole
// live in lib/shelllex.mjs, and the dispatcher that consumes `splitCommands` is
// lib/intent.mjs.

import {
  matchesHeredocDelimiter,
  matchingParen,
  readSubstitutions,
  readTopLevelHeredoc,
} from "./shelllex.mjs";

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
export function splitCommands(text, shell, depth = 0) {
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
 * @param {{ segments: string[], current: string, quote: string | null, pending: import("./shelllex.mjs").HeredocSpec[] }} state
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

/**
 * @param {string} text
 * @param {number} index
 * @param {{ end: number, spec: import("./shelllex.mjs").HeredocSpec } | { unsupported: string }} heredoc
 * @param {{ current: string, pending: import("./shelllex.mjs").HeredocSpec[] }} state
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
 * @param {{ segments: string[], current: string, pending: import("./shelllex.mjs").HeredocSpec[] }} state
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

// Skip the heredoc bodies of one command line. Each pending spec reads its own body up to its
// terminator line; a body with no terminator, or an unquoted body whose command substitution is
// not closed or nests too deeply, is `unsupported`. An unquoted body's substitutions are
// recursively split, so a governed write inside one is observed as the write it runs.
/**
 * @param {string} text
 * @param {number} start the index just after the newline that opened the bodies
 * @param {import("./shelllex.mjs").HeredocSpec[]} pending
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
 * @param {import("./shelllex.mjs").HeredocSpec} spec
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

// The command substitutions one unquoted body line runs, appended to `out` as segments. A
// quoted body is literal, so it has none. Returns the reason a substitution cannot be read,
// or null.
/**
 * @param {string} line
 * @param {import("./shelllex.mjs").HeredocSpec} spec
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
