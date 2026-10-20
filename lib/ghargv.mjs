// The gh argument reader: one left-to-right read of a gh command's tokens against an option
// table (lib/ghoptions.mjs). Every option that takes a value consumes its value, whether it is
// attached (`-Rvalue`, `-R=value`, `--repo=value`) or the next word, so a value that begins
// with the text of another flag — `gh pr create --title -Rsimpsonm09-org/demo-repo`, where
// pflag hands `-Rsimpsonm09-org/demo-repo` to `--title` — can never be read as that flag. An
// option the table does not name makes the read untrustworthy: the caller then refuses to name
// a destination instead of guessing one.

import { GLOBAL_OPTIONS } from "./ghoptions.mjs";

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

// One left-to-right read of a gh command's arguments from `start`. Each option that takes a
// value consumes it, attached or as the next word, and an option not in the table stops the
// read and marks it untrustworthy (`strict:false`). Everything before the stop is still a real
// argument, so an `-R` already taken stays authoritative; only the destination fallback is
// refused. `literalWords` (one per word, aligned with `words`) marks the words the shell will
// hand over unexpanded; an option's value carries its own word's flag, so a value built by an
// expansion can be told apart from literal text.
/**
 * @param {string[]} words
 * @param {number} start
 * @param {{ values: Set<string>, flags: Set<string> }} spec
 * @param {boolean[]} [literalWords]
 * @returns {{ options: Array<{ name: string, value: string | null, literal: boolean }>, positionals: string[], strict: boolean }}
 */
export function readGhArguments(words, start, spec, literalWords) {
  const state = {
    options: [],
    positionals: [],
    strict: true,
    literal: false,
  };
  let index = start;
  while (index < words.length) {
    const extra = readGhToken(words, index, spec, state, literalWords);
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
 * @param {{ options: Array<{ name: string, value: string | null, literal: boolean }>, positionals: string[], strict: boolean, literal: boolean }} state
 * @param {boolean[]} [literalWords]
 * @returns {number}
 */
function readGhToken(words, index, spec, state, literalWords) {
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
    state.options.push({
      name: option.name,
      value: next,
      literal: literalWords?.[index + 1] === true,
    });
    return 1;
  }
  state.options.push({
    name: option.name,
    value: option.value,
    literal: literalWords?.[index] === true,
  });
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
