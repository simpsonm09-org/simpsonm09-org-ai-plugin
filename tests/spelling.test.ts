// Every executable spelling of gh and git decides as its plain name does. The plain name is the
// reference: parity.test.ts pins its decisions to HEAD, so a spelling that decides differently is
// a gap. Each case runs both harnesses in both shells: OpenCode with the POSIX and the PowerShell
// command forms, and the Claude hook with the Bash and PowerShell tools. The golden file does
// not hold these spellings, because HEAD decided them without a token (the gap itself), so they
// are compared with the plain name live.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { decodePayload } from "../bin/payload.mjs";
import { shouldInject } from "../gate.mjs";
import { handlePreToolUse } from "../hooks/lib/claude.mjs";
import plugin from "../index.ts";
import { canonicalCommand, readShellWord } from "../lib/program.mjs";
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
import { LEVELS, PWSH } from "./support/parity-cells.mjs";

const TOKEN_ENV = { CLAUDE_CODE_GIT_BASH_PATH: process.execPath };

// One plain command per decision shape: a gh write that some levels allow and others deny, a gh
// read, a gh API write, a push to the organization main, a push to a feature branch, and a git
// command the gate never decides.
const PLAIN = [
  "gh pr merge 1",
  "gh pr create --title x",
  "gh pr view 1",
  "gh api -X POST repos/o/r",
  "git push origin main",
  "git push origin feat/x",
  "git status",
];

// Each spelling replaces the program word of a plain command. Bash and PowerShell read the same
// word differently (a backslash escapes in Bash and separates a path in PowerShell), so a few
// spellings only name the program under one reading; both readings must reach the plain name.
const SPELLINGS: Record<"gh" | "git", string[]> = {
  gh: [
    "gh.exe",
    "GH",
    "Gh.EXE",
    "/usr/bin/gh",
    "./gh",
    '"C:\\Program Files\\GitHub CLI\\gh.exe"',
    '"C:/Program Files/GitHub CLI/gh.exe"',
    '"gh".exe',
    '"C:\\Program Files\\GitHub CLI\\gh".exe',
    'g"h"',
    'gh""',
    '"g"h',
    "'g'h",
    "g\\h",
    "gh\\.exe",
    "C:/Program\\ Files/GitHub\\ CLI/gh.exe",
    ".\\gh.exe",
    "gh.exe.",
    '"gh.exe "',
    "GH.EXE",
    "gh\\\n",
  ],
  git: [
    "git.exe",
    "GIT",
    "/usr/bin/git",
    '"C:\\Program Files\\Git\\cmd\\git.exe"',
    '"git".exe',
    'gi"t"',
    "'g'it",
    '"g"it',
    "g\\it",
    "C:/Program\\ Files/Git/cmd/git.exe",
  ],
};

type OpenCodeRun = { action: string; command: string; token: boolean };
type ClaudeRun = {
  action: string;
  permission?: string;
  reason?: string;
  payload?: string;
};
type Outcome = {
  openCodePosix: OpenCodeRun;
  openCodePowerShell: OpenCodeRun;
  claudeBash: ClaudeRun;
  claudePowerShell: ClaudeRun;
};

let workspace = "";
let openCode: (input: unknown) => Promise<void>;

before(async () => {
  workspace = tempDir("spelling-");
  buildWorkspace(workspace, { level: "read" });
  openCode = await openCodeHook(plugin, { workspaceRoot: workspace });
});

after(() => {
  if (workspace) removeDir(workspace);
});

// The typed command with its program replaced: "gh pr view 1" becomes "gh.exe pr view 1".
function spelled(plain: string, spelling: string): string {
  return `${spelling}${plain.slice(plain.indexOf(" "))}`;
}

function programOf(plain: string): "gh" | "git" {
  return plain.startsWith("gh ") ? "gh" : "git";
}

function openCodeRun(
  run: Awaited<ReturnType<typeof runOpenCode>>,
): OpenCodeRun {
  return {
    action: run.action,
    command: run.command,
    token: Boolean(run.env?.GH_TOKEN),
  };
}

function claudeRun(run: Awaited<ReturnType<typeof runClaude>>): ClaudeRun {
  const text = run.output?.hookSpecificOutput?.updatedInput?.command;
  return {
    action: run.action,
    permission: run.permission,
    reason: run.reason,
    payload:
      typeof text === "string"
        ? decodePayload(/'([A-Za-z0-9+/=]+)'$/.exec(text)?.[1] ?? "").command
        : undefined,
  };
}

// The four harness answers for one command in the demo clone at the current catalog level.
async function outcomes(command: string): Promise<Outcome> {
  const cwd = cwdFor(workspace, "projects/repos/demo-repo");
  const claude = (tool: "Bash" | "PowerShell") =>
    runClaude(
      handlePreToolUse,
      { tool, cwd, command },
      { workspaceRoot: workspace, env: TOKEN_ENV },
    );
  return {
    openCodePosix: openCodeRun(
      await runOpenCode(openCode, { command, cwd }, command),
    ),
    openCodePowerShell: openCodeRun(
      await runOpenCode(openCode, { command, cwd, shell: PWSH }, command),
    ),
    claudeBash: claudeRun(await claude("Bash")),
    claudePowerShell: claudeRun(await claude("PowerShell")),
  };
}

// What each harness decided, without the text that differs by spelling. A denial names only the
// repository and the level, so its text is compared. An allowed call runs the text the caller
// typed, so that is checked against the typed command (runsTyped), not compared across spellings.
function comparable(outcome: Outcome, typed: string) {
  const openCode = (run: OpenCodeRun) => ({
    action: run.action,
    token: run.token,
    denied: run.action === "deny" ? run.command : null,
    runsTyped: run.action === "deny" ? null : run.command === typed,
  });
  const claude = (run: ClaudeRun) => ({
    action: run.action,
    permission: run.permission ?? null,
    denied: run.action === "deny" ? (run.reason ?? null) : null,
    runsTyped: run.action === "inject" ? run.payload === typed : null,
  });
  return {
    openCodePosix: openCode(outcome.openCodePosix),
    openCodePowerShell: openCode(outcome.openCodePowerShell),
    claudeBash: claude(outcome.claudeBash),
    claudePowerShell: claude(outcome.claudePowerShell),
  };
}

test("every spelling of gh and git decides as the plain name, at every level, in both harnesses and shells", async (t) => {
  const mismatches: string[] = [];
  let compared = 0;
  for (const level of LEVELS) {
    writeCatalog(workspace, level);
    for (const plain of PLAIN) {
      const want = comparable(await outcomes(plain), plain);
      for (const spelling of SPELLINGS[programOf(plain)]) {
        const command = spelled(plain, spelling);
        const got = comparable(await outcomes(command), command);
        compared += 1;
        if (JSON.stringify(got) !== JSON.stringify(want))
          mismatches.push(`${level} ${command} (plain: ${plain})`);
      }
    }
  }
  t.diagnostic(`spelled commands compared: ${compared}`);
  assert.ok(compared > 0, "the matrix ran");
  assert.deepEqual(
    mismatches,
    [],
    `a spelling decides differently from its plain name: ${mismatches.join("; ")}`,
  );
});

test("the plain names reach both a denial and an injection, so the comparison is not vacuous", async () => {
  // Without this, the comparison could pass with every decision a pass.
  const actions = new Map<string, { openCode: string; claude: string }>();
  for (const level of LEVELS) {
    writeCatalog(workspace, level);
    const run = await outcomes("gh pr merge 1");
    actions.set(level, {
      openCode: run.openCodePosix.action,
      claude: run.claudeBash.action,
    });
  }
  assert.deepEqual(actions.get("none"), { openCode: "deny", claude: "deny" });
  assert.deepEqual(actions.get("merge"), {
    openCode: "inject",
    claude: "inject",
  });
});

test("an allowed spelled call runs the spelling the caller typed, and the launcher payload carries it", async () => {
  writeCatalog(workspace, "full");
  for (const command of [
    "gh.exe pr merge 1",
    '"C:\\Program Files\\GitHub CLI\\gh.exe" pr merge 1',
    "GIT.exe push origin feat/x",
  ]) {
    const got = comparable(await outcomes(command), command);
    assert.notEqual(got.openCodePosix.action, "deny", command);
    assert.equal(got.openCodePosix.runsTyped, true, command);
    assert.equal(got.openCodePowerShell.runsTyped, true, command);
  }
  const gh = comparable(
    await outcomes("gh.exe pr merge 1"),
    "gh.exe pr merge 1",
  );
  assert.equal(gh.claudeBash.action, "inject");
  assert.equal(gh.claudeBash.runsTyped, true);
});

// A leading tab is one more whitespace before the program, so it must decide as the plain name
// with the same tab. Each harness call spawns git, so one spelling of each kind stands for the rest.
const LEADING_TAB_SPELLINGS: Record<"gh" | "git", string[]> = {
  gh: ['"gh".exe', "gh.exe", "g\\h"],
  git: ['"git".exe', 'gi"t"'],
};

test("a leading tab decides as the plain name with the same tab, for a spelling of each kind", async () => {
  const mismatches: string[] = [];
  for (const level of LEVELS) {
    writeCatalog(workspace, level);
    for (const plain of PLAIN) {
      const typedPlain = `\t${plain}`;
      const want = comparable(await outcomes(typedPlain), typedPlain);
      for (const spelling of LEADING_TAB_SPELLINGS[programOf(plain)]) {
        const command = `\t${spelled(plain, spelling)}`;
        const got = comparable(await outcomes(command), command);
        if (JSON.stringify(got) !== JSON.stringify(want))
          mismatches.push(`${level} ${JSON.stringify(command)}`);
      }
    }
  }
  assert.deepEqual(mismatches, [], "a leading tab changes a decision");
});

test("a leading tab decides as a leading space does, for each plain name", async () => {
  const mismatches: string[] = [];
  for (const level of LEVELS) {
    writeCatalog(workspace, level);
    for (const plain of PLAIN) {
      const tab = `\t${plain}`;
      const space = ` ${plain}`;
      const got = comparable(await outcomes(tab), tab);
      const want = comparable(await outcomes(space), space);
      if (JSON.stringify(got) !== JSON.stringify(want))
        mismatches.push(`${level} ${JSON.stringify(tab)}`);
    }
  }
  assert.deepEqual(mismatches, [], "a tab and a space decide differently");
});

test("a word that only contains gh or git is not a spelling of it, and passes at every level", async () => {
  const words = [
    "github",
    "ghc",
    "gitk",
    "git-lfs",
    "gh-dash",
    '"gh-dash"',
    "xgh",
    "ghx.exe",
    "mygit.exe",
  ];
  for (const word of words) {
    const command = `${word} pr merge 1`;
    assert.equal(canonicalCommand(command), command, word);
    assert.equal(shouldInject(command), false, word);
  }
  writeCatalog(workspace, "none");
  for (const word of words) {
    const command = `${word} pr merge 1`;
    const run = await outcomes(command);
    assert.equal(run.openCodePosix.action, "pass", word);
    assert.equal(run.claudeBash.action, "pass", word);
  }
});

test("a first word with an unquoted $, a backtick, or ( is left exactly as typed", () => {
  for (const command of [
    "$gh pr merge 1",
    "$(gh) pr merge 1",
    "gh$x pr merge 1",
    '"gh"$x pr merge 1',
    "`gh` pr merge 1",
    "(gh) pr merge 1",
    '("gh".exe pr merge 1)',
  ]) {
    assert.equal(canonicalCommand(command), command, command);
  }
});

test("readShellWord reads a quoted Windows path with spaces as one PowerShell word", () => {
  const text = '"C:\\Program Files\\GitHub CLI\\gh".exe pr merge 1';
  const read = readShellWord(text, 0, "powershell");
  assert.equal(read?.word, "C:\\Program Files\\GitHub CLI\\gh.exe");
  assert.equal(read?.end, text.indexOf(" pr"));
});

test("readShellWord reads an escaped-space Bash path as one Bash word, and PowerShell stops at the space", () => {
  const text = "C:/Program\\ Files/GitHub\\ CLI/gh.exe pr merge 1";
  assert.equal(
    readShellWord(text, 0, "bash")?.word,
    "C:/Program Files/GitHub CLI/gh.exe",
  );
  assert.equal(readShellWord(text, 0, "powershell")?.word, "C:/Program\\");
});

test("readShellWord joins adjacent quoted and unquoted pieces, and reads PowerShell's doubled quote", () => {
  assert.equal(readShellWord('gi"t" push', 0, "bash")?.word, "git");
  assert.equal(readShellWord("'g'it push", 0, "bash")?.word, "git");
  assert.equal(readShellWord("g\\it push", 0, "bash")?.word, "git");
  assert.equal(readShellWord("g\\it push", 0, "powershell")?.word, "g\\it");
  assert.equal(readShellWord("'g''h' push", 0, "powershell")?.word, "g'h");
  assert.equal(readShellWord("\u201cgh\u201d pr", 0, "powershell")?.word, "gh");
});

test("readShellWord reads from a start index, past leading whitespace", () => {
  const text = "  gh.exe pr";
  assert.equal(readShellWord(text, 2, "bash")?.word, "gh.exe");
  assert.equal(readShellWord(text, 2, "bash")?.end, 8);
});

test("readShellWord returns null for an unquoted $, backtick, or (", () => {
  for (const text of ["$gh pr", "$(gh) pr", "`gh` pr", "(gh) pr", "gh$x pr"]) {
    assert.equal(readShellWord(text, 0, "bash"), null, text);
    assert.equal(readShellWord(text, 0, "powershell"), null, text);
  }
});
