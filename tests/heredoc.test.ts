// A heredoc body is data, not commands. A command that writes a script or a document through
// bash is a normal agent action, so its body must not be decided as commands. This runs the
// real public decision: the OpenCode adapter and the Claude hook over a real fixture workspace
// and the packaged, hash-verified resolver. The one exception is that an unquoted heredoc body
// still expands command substitutions, so a `$(...)` or backtick in it is observed as the
// command the shell would run.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { handlePreToolUse } from "../hooks/lib/claude.mjs";
import plugin from "../index.ts";
import {
  buildWorkspace,
  removeDir,
  tempDir,
  writeCatalog,
} from "./support/fixture-workspace.mjs";
import {
  cwdFor,
  openCodeHook,
  runClaude,
  runOpenCode,
} from "./support/harness.mjs";

const TOKEN_ENV = { CLAUDE_CODE_GIT_BASH_PATH: process.execPath };
const CWD = "projects/repos/demo-repo";

type Case = {
  id: string;
  command: string;
  action: "pass" | "deny";
  reason?: RegExp;
};

const CASES: Case[] = [
  {
    id: "a quoted heredoc script body is data",
    command: "cat > run.sh <<'EOF'\ngit push origin main\nEOF",
    action: "pass",
  },
  {
    id: "a quoted heredoc script body with a gh row is data",
    command:
      "cat > run.sh <<'EOF'\ngh pr create -R simpsonm09-org/demo-repo --title x\nEOF",
    action: "pass",
  },
  {
    id: "a tab-stripping heredoc body is data",
    command: "cat > run.sh <<-EOF\n\tgit push origin main\n\tEOF",
    action: "pass",
  },
  {
    id: "an unquoted heredoc body of ordinary text is data",
    command: "cat > notes.md <<EOF\nRun: git push origin main\nEOF",
    action: "pass",
  },
  {
    id: "a here-string is not a heredoc",
    command: "cat <<< 'git push origin main'",
    action: "pass",
  },
  {
    id: "a quoted heredoc keeps a command substitution literal",
    command: "cat > notes.md <<'EOF'\n$(git push origin main)\nEOF",
    action: "pass",
  },
  {
    id: "an unquoted heredoc substitution that is a push is a governed write",
    command: "cat > notes.md <<EOF\n$(git push origin main)\nEOF",
    action: "deny",
    reason: /compound command/,
  },
  {
    id: "an unquoted heredoc backtick substitution that is a gh write is a governed write",
    command:
      "cat > notes.md <<EOF\n`gh pr create -R simpsonm09-org/demo-repo --title x`\nEOF",
    action: "deny",
    reason: /compound command/,
  },
  {
    id: "a governed command after the terminator is decided",
    command:
      "cat <<'EOF'\ntext\nEOF\ngh pr create -R simpsonm09-org/demo-repo --title x",
    action: "deny",
    reason: /compound command/,
  },
  {
    id: "an unterminated heredoc fails closed",
    command: "cat <<EOF\ngit push origin main",
    action: "deny",
    reason: /terminator/,
  },
  {
    id: "a heredoc with no delimiter fails closed",
    command: "cat <<",
    action: "deny",
    reason: /delimiter/,
  },
];

let workspace = "";
let hook: (input: unknown) => Promise<void>;

before(async () => {
  workspace = tempDir("gate-heredoc-");
  buildWorkspace(workspace, { level: "propose" });
  writeCatalog(workspace, "propose");
  hook = await openCodeHook(plugin, { workspaceRoot: workspace });
});

after(() => {
  if (workspace) removeDir(workspace);
});

test("a heredoc body is data, its substitutions are commands, per the public decision", async (t) => {
  const cwd = cwdFor(workspace, CWD);
  let compared = 0;
  let denied = 0;
  for (const item of CASES) {
    const openCode = await runOpenCode(
      hook,
      { command: item.command, cwd },
      item.command,
    );
    const claude = await runClaude(
      handlePreToolUse,
      { tool: "Bash", cwd, command: item.command },
      { workspaceRoot: workspace, env: TOKEN_ENV },
    );
    compared += 1;
    assert.equal(openCode.action, item.action, `${item.id}: OpenCode`);
    assert.equal(claude.action, item.action, `${item.id}: Claude`);
    if (item.action === "deny") {
      denied += 1;
      const message = openCode.command;
      assert.match(message, /^printf .*agent-access: denied: /, item.id);
      if (item.reason) assert.match(message, item.reason, item.id);
      assert.doesNotMatch(message, /destination unknown/i, item.id);
      assert.doesNotMatch(
        message,
        /retry|re-run|another shell|wrapper/i,
        item.id,
      );
    } else {
      assert.equal(openCode.command, item.command, item.id);
    }
  }
  t.diagnostic(`heredoc cases: ${compared}, denied: ${denied}`);
});

test("a malformed heredoc is bounded and does not hang", async () => {
  const cwd = cwdFor(workspace, CWD);
  const command = `cat <<EOF\n${"data line\n".repeat(50)}still no terminator`;
  const started = Date.now();
  const openCode = await runOpenCode(hook, { command, cwd }, command);
  const elapsed = Date.now() - started;
  assert.equal(openCode.action, "deny");
  assert.ok(elapsed < 5000, `the malformed heredoc decided in ${elapsed} ms`);
});
