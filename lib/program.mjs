// The program a command word runs, and the form of a command the decision reads.

// The program a shell word runs. The name is the last path segment on either separator, with
// the trailing dots and spaces that Windows ignores removed, lower-cased, and one trailing .exe,
// .cmd, .bat or .com dropped. Surrounding quotes are stripped for a word that still has them.
/**
 * @param {string} word
 * @returns {string}
 */
export function programName(word) {
  const unquoted = word.replace(/^(["'])(.*)\1$/, "$2");
  const last = unquoted.split(/[\\/]/).pop() ?? "";
  const bare = withoutTrailingDots(last)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|com)$/, "");
  return withoutTrailingDots(bare);
}

// Windows drops trailing dots and spaces when it resolves a path, so "gh.exe." and "gh.exe "
// run gh.exe.
/**
 * @param {string} name
 * @returns {string}
 */
function withoutTrailingDots(name) {
  // A loop, not /[. ]+$/: that pattern is quadratic on a long run that does not end the name.
  let end = name.length;
  while (end > 0 && (name[end - 1] === "." || name[end - 1] === " ")) end -= 1;
  return name.slice(0, end);
}

// The quote characters each shell reads. PowerShell also reads the typographic quotes as quotes.
const BASH_QUOTES = { single: ["'"], double: ['"'] };
const POWERSHELL_QUOTES = {
  single: ["'", "‘", "’", "‚", "‛"],
  double: ['"', "“", "”", "„"],
};

// The characters a backslash escapes inside Bash double quotes.
const BASH_DOUBLE_ESCAPES = ['"', "\\", "$", "`"];

// The contents of a single-quoted piece whose opening quote is just before `index`. Bash reads
// it verbatim. PowerShell reads a doubled quote as one quote.
/**
 * @param {string} text
 * @param {number} index
 * @param {string[]} quotes
 * @param {boolean} bash
 * @returns {{ contents: string, next: number }}
 */
function readSingleQuoted(text, index, quotes, bash) {
  let contents = "";
  let i = index;
  while (i < text.length) {
    if (!quotes.includes(text[i])) {
      contents += text[i];
      i += 1;
    } else if (!bash && quotes.includes(text[i + 1])) {
      contents += text[i];
      i += 2;
    } else return { contents, next: i + 1 };
  }
  return { contents, next: i };
}

// The contents of a double-quoted piece whose opening quote is just before `index`. Bash: a
// backslash before " \ $ or ` escapes that character, and a backslash before a newline continues
// the line. PowerShell: a backtick escapes the next character, and a doubled quote is one quote.
// `literal` is false when the piece expands something: Bash's `$` or backtick, or PowerShell's
// `$` or backtick. An escaped expansion (`"\$"`) is the literal character and stays literal in
// Bash; PowerShell's backtick is treated as an expansion anyway, because its escape sequences
// (`n`, `t`, ...) also change the text.
/**
 * @param {string} text
 * @param {number} index
 * @param {string[]} quotes
 * @param {boolean} bash
 * @returns {{ contents: string, next: number, literal: boolean }}
 */
function readDoubleQuoted(text, index, quotes, bash) {
  let contents = "";
  let literal = true;
  let i = index;
  while (i < text.length) {
    const step = doubleQuotedStep(text, i, quotes, bash);
    if (!step) return { contents, next: i + 1, literal };
    contents += step.text;
    literal = literal && step.literal;
    i = step.next;
  }
  return { contents, next: i, literal };
}

// One step inside a double-quoted piece at index i: the text it yields, the index past it, and
// whether it is literal text. Returns null at the closing quote.
/**
 * @param {string} text
 * @param {number} i
 * @param {string[]} quotes
 * @param {boolean} bash
 * @returns {{ text: string, next: number, literal: boolean } | null}
 */
function doubleQuotedStep(text, i, quotes, bash) {
  const char = text[i];
  const hasNext = i + 1 < text.length;
  if (quotes.includes(char)) {
    return !bash && quotes.includes(text[i + 1])
      ? { text: char, next: i + 2, literal: true }
      : null;
  }
  if (bash && char === "\\" && hasNext) {
    const escaped = text[i + 1];
    if (escaped === "\n") return { text: "", next: i + 2, literal: true };
    if (BASH_DOUBLE_ESCAPES.includes(escaped))
      return { text: escaped, next: i + 2, literal: true };
  }
  if (!bash && char === "`" && hasNext)
    return { text: text[i + 1], next: i + 2, literal: false };
  if (char === "$" || char === "`")
    return { text: char, next: i + 1, literal: false };
  return { text: char, next: i + 1, literal: true };
}

// The characters an unquoted word expands with a glob or brace pattern. A word carrying one is
// not literal text: the shell may hand the program more than one word, or a different word.
const UNQUOTED_PATTERN_CHARS = "*?[{";

// The first shell word of `text` from `start`, read as the given shell reads it: a run of
// adjacent pieces up to the first unquoted whitespace. A piece is a double-quoted string, a
// single-quoted string, an escaped character (Bash only: a backslash), or a character outside
// quotes. Returns the word's text, the index just past it, and whether the word is provably
// literal: no expansion, no glob, and no brace pattern in any piece. Returns null when the word
// has an unquoted $, backtick or (, which the gate does not read.
/**
 * @param {string} text
 * @param {number} start
 * @param {"bash" | "powershell"} shell
 * @returns {{ word: string, end: number, literal: boolean } | null}
 */
export function readShellWord(text, start, shell) {
  const bash = shell === "bash";
  const quotes = bash ? BASH_QUOTES : POWERSHELL_QUOTES;
  let word = "";
  let literal = true;
  let i = start;
  while (i < text.length && !/\s/.test(text[i])) {
    const piece = readPiece(text, i, quotes, bash);
    if (!piece) return null;
    word += piece.contents;
    literal = literal && piece.literal;
    i = piece.next;
  }
  return { word, end: i, literal };
}

// One piece of a shell word at index i: its contents, the index past it, and whether it is
// literal, or null for an unquoted $, backtick or (.
/**
 * @param {string} text
 * @param {number} i
 * @param {{ single: string[], double: string[] }} quotes
 * @param {boolean} bash
 * @returns {{ contents: string, next: number, literal: boolean } | null}
 */
function readPiece(text, i, quotes, bash) {
  const char = text[i];
  if (quotes.double.includes(char))
    return readDoubleQuoted(text, i + 1, quotes.double, bash);
  if (quotes.single.includes(char))
    return {
      ...readSingleQuoted(text, i + 1, quotes.single, bash),
      literal: true,
    };
  if (bash && char === "\\" && i + 1 < text.length) {
    const escaped = text[i + 1];
    return {
      contents: escaped === "\n" ? "" : escaped,
      next: i + 2,
      literal: true,
    };
  }
  if ("$`(".includes(char)) return null;
  return {
    contents: char,
    next: i + 1,
    literal: !UNQUOTED_PATTERN_CHARS.includes(char),
  };
}

// The command the decision reads. A backslash is an escape in Bash and a path separator in
// PowerShell, and the gate does not know which shell runs the command, so the first word is read
// both ways. When either reading names gh or git, that word becomes the plain name and nothing
// else changes, because the resolver matches only the plain names. Bash is tried first, since
// its reading is the one that runs a word with an escaped space. Leading whitespace is kept as
// typed. The command that runs keeps the spelling the caller typed; only the decision reads this.
/**
 * @param {string} command
 * @returns {string}
 */
export function canonicalCommand(command) {
  const lead = /^\s*/.exec(command)?.[0] ?? "";
  for (const shell of ["bash", "powershell"]) {
    const read = readShellWord(command, lead.length, shell);
    if (!read) continue;
    const name = programName(read.word);
    if (name === "gh" || name === "git")
      return `${lead}${name}${command.slice(read.end)}`;
  }
  return command;
}
