// Where the plugin lives decides which workspace it trusts. The launcher and the Claude
// hook take the resolver and the token broker only from the workspace their own files sit
// in, never from the working directory or the environment: a planted workspace under the
// cwd, or an environment variable, must not choose the script that decides what may run or
// mints a token.
//
// Two layouts are trusted:
//   <workspace>/.opencode/plugins/<name>           the installed plugin (a junction from
//                                                  <workspace>/.claude/plugins/<name> realpaths here)
//   <workspace>/projects/<repos|worktrees>/<name>  the development checkout
// A plugin outside both trusts no workspace. The Claude hook then denies a write it cannot
// check, and the launcher runs nothing (see hooks/lib/claude.mjs and bin/with-gh-token.mjs).

import { realpathSync } from "node:fs";

/**
 * The real path of a path, or the path itself when it does not exist.
 * @param {string} path
 * @returns {string}
 */
export function realPath(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * The workspace a plugin root belongs to, or null when the root is in neither layout.
 * The root must already be a real path.
 * @param {string} root
 * @returns {string | null}
 */
export function workspaceForPluginRoot(root) {
  const normal = root.replace(/\\/g, "/");
  const installed = /^(.*)\/\.opencode\/plugins\/[^/]+$/i.exec(normal);
  if (installed) return root.slice(0, installed[1].length);
  const checkout = /^(.*)\/projects\/(repos|worktrees)\/[^/]+$/i.exec(normal);
  if (checkout) return root.slice(0, checkout[1].length);
  return null;
}
