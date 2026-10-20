// The focused cross-platform regression behind `just test-portable`, the recipe the
// `test-windows` and `test-macos` jobs run beside the full Linux suite. It drives the
// plugin's own path, cwd, and shell-word helpers over the inputs that break a naive
// implementation on a non-POSIX host: a workspace path with a space and non-ASCII
// characters, both path separators, and a CRLF-terminated command. The full suite
// stays in `just test`.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  isWorktreePath,
  powerShellQuote,
  repoFromCwd,
  shellQuote,
  shouldInject,
  tokenize,
} from "../gate.mjs";
import { gitBashPath } from "../lib/bash.mjs";
import { realPath, workspaceForPluginRoot } from "../lib/location.mjs";
import {
  canonicalCommand,
  programName,
  readShellWord,
} from "../lib/program.mjs";

test("workspace recognition takes a spaced, non-ASCII install path with either separator", () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "portable-workspace-")));
  try {
    const workspace = join(root, "spaced ünïcode workspace");
    const install = join(workspace, ".opencode", "plugins", "org-ai-plugin");
    mkdirSync(install, { recursive: true });
    const realInstall = realPath(install);
    const expected = realPath(workspace);
    assert.equal(workspaceForPluginRoot(realInstall), expected);
    assert.equal(
      workspaceForPluginRoot(realInstall.replace(/\//g, "\\"))?.replace(
        /\\/g,
        "/",
      ),
      expected.replace(/\\/g, "/"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a spaced, non-ASCII clone and worktree path still name their location", () => {
  const workspace = join(tmpdir(), "portable spaced workspace");
  const repo = "répo name";
  assert.equal(
    repoFromCwd(join(workspace, "projects", "repos", repo, "src"), workspace),
    repo,
  );
  assert.equal(
    repoFromCwd(join(workspace, "projects", "repos"), workspace),
    null,
  );
  assert.equal(
    isWorktreePath(join(workspace, "projects", "worktrees", "wt x"), workspace),
    true,
  );
  assert.equal(
    isWorktreePath(join(workspace, "projects", "repos", repo), workspace),
    false,
  );
});

test("a quoted Windows path with a space reads as one word and one program name", () => {
  const quoted = String.raw`"C:\Program Files\Git\bin\git.exe"`;
  assert.equal(
    readShellWord(quoted, 0, "powershell")?.word,
    String.raw`C:\Program Files\Git\bin\git.exe`,
  );
  assert.equal(programName(String.raw`C:\Program Files\Git\bin\gh.exe`), "gh");
  assert.equal(
    canonicalCommand(`${quoted} push origin main`),
    "git push origin main",
  );
});

test("a spaced, non-ASCII argument with a quote stays one shell word in both shells", () => {
  const value = "répo name's";
  assert.equal(
    readShellWord(powerShellQuote(value), 0, "powershell")?.word,
    value,
  );
  assert.equal(readShellWord(shellQuote(value), 0, "bash")?.word, value);
});

test("a CRLF-terminated command reads the line break as whitespace", () => {
  assert.deepEqual(tokenize("git push\r\norigin main"), [
    "git",
    "push",
    "origin",
    "main",
  ]);
  assert.equal(readShellWord("git push\r\n", 0, "bash")?.word, "git");
  assert.equal(shouldInject("gh pr create\r\n"), true);
});

test("the Git Bash lookup answers the configured path on Windows and bash elsewhere", () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "portable-bash-")));
  try {
    const dir = join(root, "spaced ünïcode bin");
    mkdirSync(dir, { recursive: true });
    const bash = join(dir, "bash.exe");
    writeFileSync(bash, "");
    const configured = { CLAUDE_CODE_GIT_BASH_PATH: bash };
    assert.equal(gitBashPath(configured, "win32"), bash);
    assert.equal(
      gitBashPath(
        { CLAUDE_CODE_GIT_BASH_PATH: join(dir, "absent.exe") },
        "win32",
      ),
      null,
    );
    assert.equal(gitBashPath({}, "darwin"), "bash");
    assert.equal(gitBashPath(configured, "darwin"), "bash");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
