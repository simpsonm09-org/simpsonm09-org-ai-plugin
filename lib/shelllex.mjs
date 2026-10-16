// The lexical forms inside a shell text that the top-level scanner (lib/shellscan.mjs) keeps
// as opaque spans: a quoted word, an arithmetic expansion, a command substitution, and a
// heredoc operator with its delimiter. Every reader here is pure and bounded, and a form that
// cannot be read safely returns `unsupported` so the observer fails closed instead of guessing.
// A newline, a separator, and a heredoc body are the scanner's concern, not this module's.

// One heredoc operator the scanner found: where its delimiter word ends, the delimiter the
// terminator line must equal, whether the body is literal (a quoted or escaped delimiter), and
// whether leading tabs are stripped (the `<<-` form).
/**
 * @typedef {{ delimiter: string, quoted: boolean, stripTabs: boolean }} HeredocSpec
 */

// The `<<` operator at `index` when it opens a heredoc, or null when the `<<` is part of a
// `<<<` here-string or a `<<` shift.
/**
 * @param {string} text
 * @param {number} index
 * @param {boolean} bash
 * @returns {{ end: number, spec: HeredocSpec } | { unsupported: string } | null}
 */
export function readTopLevelHeredoc(text, index, bash) {
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

/**
 * @param {string} line
 * @param {HeredocSpec} spec
 * @returns {boolean}
 */
export function matchesHeredocDelimiter(line, spec) {
  const compare = spec.stripTabs ? line.replace(/^\t+/, "") : line;
  return compare === spec.delimiter;
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
export function matchingParen(text, start) {
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

// The command substitutions a shell text carries: the inner text of each `$(...)` and each
// backtick pair. A substitution that is not closed is `unsupported`.
/**
 * @param {string} text
 * @returns {{ commands: string[] } | { unsupported: string }}
 */
export function readSubstitutions(text) {
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
