// The program a command word runs, and the form of a command the decision reads.

// The program a command word runs. The rule: surrounding quotes stripped, the last path segment
// taken on either separator, lower-cased, and a trailing .exe, .cmd, .bat or .com dropped. On
// Windows gh.exe, GH and a full path to gh run the same program as gh, so they get the same answer.
/**
 * @param {string} word
 * @returns {string}
 */
export function programName(word) {
  const unquoted = word.replace(/^(["'])(.*)\1$/, "$2");
  const last = unquoted.split(/\\|\//).pop() ?? "";
  return last.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");
}

// The first word of a command, after its leading whitespace: a quoted string or a run of
// characters without a space, as tokenize splits them.
const FIRST_WORD = /^(\s*)("[^"]*"|'[^']*'|\S+)/;

// The command the decision reads. When its first word names gh or git, that word becomes the
// plain name and nothing else changes, because the resolver matches only the plain names. The
// command that runs keeps the spelling the caller typed; only the decision reads this form.
/**
 * @param {string} command
 * @returns {string}
 */
export function canonicalCommand(command) {
  const match = FIRST_WORD.exec(command);
  if (!match) return command;
  const name = programName(match[2]);
  if (name !== "gh" && name !== "git") return command;
  return `${match[1]}${name}${command.slice(match[0].length)}`;
}
