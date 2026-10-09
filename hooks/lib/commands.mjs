// Command-shape checks the Claude Code hook makes for itself. None of them is a gate decision
// (gate.mjs decides allow, deny, or inject). They choose how the hook answers: whether a call
// runs the launcher directly, whether a gh call is clearly a read so its prompt can be skipped,
// and how a command is shown in an ask prompt.

import { tokenize } from "../../gate.mjs";
import { canonicalCommand, programName } from "../../lib/program.mjs";

// The longest command shown in an ask prompt, in characters.
const SHOWN_COMMAND_MAX = 300;

const LAUNCHER_FILE = /^with-gh-?token(\.mjs)?$/i;
const NODE_RUNNER = /^(node|nodejs)$/;

// Whether one simple command runs the launcher as its program, or runs node on it.
// Leading NAME=value assignments are skipped.
/**
 * @param {string} segment
 * @returns {boolean}
 */
function segmentRunsLauncher(segment) {
  const words = tokenize(segment);
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]))
    index += 1;
  const program = words[index];
  if (!program) return false;
  if (LAUNCHER_FILE.test(programName(program))) return true;
  return (
    NODE_RUNNER.test(programName(program)) &&
    LAUNCHER_FILE.test(programName(words[index + 1] ?? ""))
  );
}

// Whether a command runs the launcher directly, in any simple command it contains. This is
// a cheap check on the program position, not a text search: naming the launcher as an
// argument does not run it. The launcher's own re-decision is the control.
/**
 * @param {string} command
 * @returns {boolean}
 */
export function runsLauncher(command) {
  return command.split(/[;&|()`\n]/).some(segmentRunsLauncher);
}

// The gh commands that only read. A gh command is read-only only when it is one of these
// and has no shell operator, redirection, or substitution: anything else asks. This list only
// chooses between "allow" and "ask"; it is not a gate decision.
const READ_VERBS = new Map([
  ["pr", ["view", "list", "checks", "diff", "status"]],
  ["issue", ["view", "list", "status"]],
  ["run", ["view", "list", "watch"]],
  ["repo", ["view"]],
  ["release", ["view", "list"]],
  ["workflow", ["view", "list"]],
]);
const API_WRITE_FLAGS = [
  "-X",
  "-f",
  "-F",
  "--method",
  "--field",
  "--raw-field",
  "--input",
];

/**
 * Whether a gh command is clearly read-only, so its prompt can be skipped. This chooses
 * between "allow" and "ask" only; it is not a gate decision. Anything unclear asks.
 * @param {string} command
 * @param {"bash" | "powershell"} [shell] the dialect the command is read in
 * @returns {boolean}
 */
export function readOnlyGh(command, shell = "bash") {
  const text = canonicalCommand(command);
  if (/[;&|<>`$(){}\r\n]/.test(text)) return false;
  const words = tokenize(text, shell);
  if (programName(words[0] ?? "") !== "gh") return false;
  const group = words[1];
  if (group === "search" || group === "status") return true;
  if (group === "api") {
    return !words
      .slice(1)
      .some((word) => API_WRITE_FLAGS.some((flag) => word.startsWith(flag)));
  }
  return READ_VERBS.get(group ?? "")?.includes(words[2] ?? "") ?? false;
}

// The command as shown in an ask prompt: control characters become spaces, runs of space
// collapse, and a long command is cut with an ellipsis.
/**
 * @param {string} command
 * @returns {string}
 */
export function displayCommand(command) {
  const printable = Array.from(command, (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? " " : char;
  });
  const clean = printable.join("").replace(/\s+/g, " ").trim();
  return clean.length > SHOWN_COMMAND_MAX
    ? `${clean.slice(0, SHOWN_COMMAND_MAX)}...`
    : clean;
}
