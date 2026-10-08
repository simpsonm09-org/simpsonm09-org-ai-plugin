// The payload that carries an allowed gh command from the PreToolUse hook to the
// launcher. It is base64 of one JSON object, so the rewritten command line holds
// only base64 characters: no quote, pipe, or ampersand reaches the shell. The
// payload holds the workspace, the repository, and the original command, never a
// token. The launcher does not trust it: it re-decides the command from its own
// workspace (bin/with-gh-token.mjs). Both the hook (hooks/lib/claude.mjs) and the
// launcher import this module.

// A repository name: letters, digits, dots, underscores, and hyphens, never only
// dots (which would name the directory itself or its parent).
export const REPO_NAME = /^(?!\.+$)[A-Za-z0-9._-]{1,100}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * @param {{ workspace: string, repo: string, command: string }} payload
 * @returns {string}
 */
export function encodePayload(payload) {
  return Buffer.from(
    JSON.stringify({
      workspace: payload.workspace,
      repo: payload.repo,
      command: payload.command,
    }),
    "utf8",
  ).toString("base64");
}

/**
 * Decode and check a payload. Throws on anything that is not a well-formed payload,
 * so the launcher fails closed.
 * @param {unknown} text
 * @returns {{ workspace: string, repo: string, command: string }}
 */
export function decodePayload(text) {
  if (typeof text !== "string" || !BASE64.test(text)) {
    throw new Error("payload is not base64");
  }
  const parsed = JSON.parse(Buffer.from(text, "base64").toString("utf8"));
  if (
    typeof parsed?.workspace !== "string" ||
    typeof parsed?.command !== "string" ||
    typeof parsed?.repo !== "string" ||
    !REPO_NAME.test(parsed.repo)
  ) {
    throw new Error("payload has no valid workspace, repo, or command");
  }
  return {
    workspace: parsed.workspace,
    repo: parsed.repo,
    command: parsed.command,
  };
}
