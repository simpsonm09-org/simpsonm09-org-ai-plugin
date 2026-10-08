// The cells the differential compares: a command, a working directory, a level, and a shell.
// The committed test runs a subset (fixed, so CI time is bounded) against the golden
// outcomes recorded from HEAD's gate; the full matrix is run once, live, against HEAD in the
// scratch parity runner. Both use these lists, so they cannot drift.

// Every command the parity table covers. The first group is the plain git and gh surface;
// the rest are the shapes that a first-token gate reads differently.
export const COMMANDS = [
  "git status",
  "git diff",
  "git log --oneline",
  "git fetch origin",
  "git pull",
  "git commit -m x",
  "git checkout -b feat/x",
  "git push origin main",
  "git push origin feat/x",
  "git push",
  "git push --force origin main",
  "git push fork feat/x",
  "git push --dry-run origin main",
  "git push origin :main",
  "git push upstream refs/heads/main",
  "git push origin HEAD",
  "git tag v1",
  "git branch -D feat/x",
  "gh pr view 1",
  "gh pr list",
  "gh pr create --title x",
  "gh pr merge 1",
  "gh pr merge 1 --squash",
  "gh pr comment 1 --body x",
  "gh api repos/o/r",
  "gh api repos/o/r --method PATCH",
  "gh api -X POST repos/o/r",
  "gh api -X get repos/o/r",
  "gh repo delete o/r --yes",
  "gh repo view",
  "gh release create v1",
  "gh release list",
  "gh workflow run ci.yml",
  "gh run list",
  "gh search prs x",
  "gh status",
  "gh auth status",
  "gh pr list | jq .",
  "gh pr list; echo x",
  "cd x && git push origin main",
  "FOO=1 git push origin main",
  " gh pr list",
  "npm test",
  "node -e 1",
  "bash scripts/x.sh",
  "rm -rf build",
  "ls -la",
  "echo hi > out.txt",
];

// The working directories, relative to the workspace. demo-root is a clone; the others are a
// nested folder, a fork clone, a directory with no git, a clone the catalog does not name,
// a directory outside the fleet, and a worktree of demo-repo (the one intended change).
export const CWDS = [
  { id: "demo-root", path: "projects/repos/demo-repo" },
  { id: "demo-sub", path: "projects/repos/demo-repo/src/deep" },
  { id: "fork", path: "projects/repos/fork-repo" },
  { id: "nogit", path: "projects/repos/nogit-repo" },
  { id: "unlisted", path: "projects/repos/unlisted-repo" },
  { id: "outside", path: "projects/other/x" },
  { id: "worktree", path: "projects/worktrees/wt-demo" },
  { id: "case-variant", path: "projects/REPOS/DEMO-REPO" },
  { id: "junction", path: "projects/other/link-demo" },
];

// The cwds whose OpenCode outcome is an intended change from HEAD, and which must therefore
// match the outcome of their clone (demo-root). A worktree is gated like its clone; a case
// variant of a clone's path, and a junction from outside projects/repos into a clone, are named
// by their real path.
export const INTENDED_CWDS = ["worktree", "case-variant", "junction"];

// The case-variant cell needs a case-insensitive file system: on a case-sensitive one the
// uppercase path names nothing, and the parity test skips it there.
export const CASE_SENSITIVE_CWDS = ["case-variant"];

export const LEVELS = ["none", "read", "propose", "merge", "full"];

export const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

// The subsets the committed test runs. Every command runs at the clone; the other
// directories run a representative few at every level, and pwsh runs a few.
const SUBSET_BY_CWD = {
  "demo-sub": [
    "git push origin main",
    "git push origin feat/x",
    "gh pr merge 1",
    "gh api -X POST repos/o/r",
    "gh pr view 1",
    "npm test",
  ],
  fork: [
    "git push origin main",
    "git push",
    "gh pr merge 1",
    "gh pr view 1",
    "cd x && git push origin main",
    "npm test",
  ],
  nogit: ["git push origin main", "gh pr merge 1", "npm test"],
  unlisted: ["git push origin main", "gh pr merge 1", "npm test"],
  outside: ["git push origin main", "gh pr view 1"],
  worktree: [
    "git push origin main",
    "git push origin feat/x",
    "gh pr merge 1",
    "gh pr view 1",
    "gh api -X POST repos/o/r",
    "npm test",
  ],
  "case-variant": [
    "git push origin main",
    "git push origin feat/x",
    "gh pr merge 1",
    "gh pr view 1",
    "npm test",
  ],
  junction: [
    "git push origin main",
    "git push origin feat/x",
    "gh pr merge 1",
    "gh pr view 1",
    "npm test",
  ],
};
const PWSH_COMMANDS = [
  "git push origin main",
  "gh pr merge 1",
  "gh pr view 1",
  "npm test",
  "gh api -X POST repos/o/r",
];

/**
 * @typedef {{ id: string, cwd: string, cwdPath: string, command: string, level: string, shell?: string }} Cell
 */

/**
 * @param {string} cwdId
 * @param {string} command
 * @param {string} level
 * @param {string} [shell]
 * @returns {Cell}
 */
function cellFor(cwdId, command, level, shell) {
  const cwd = CWDS.find((entry) => entry.id === cwdId);
  if (!cwd) throw new Error(`unknown cwd ${cwdId}`);
  const id = `${cwdId}|${shell ? "pwsh" : "posix"}|${level}|${command}`;
  return {
    id,
    cwd: cwdId,
    cwdPath: cwd.path,
    command,
    level,
    ...(shell ? { shell } : {}),
  };
}

/**
 * The committed subset: every command at the clone at every level, the representative
 * commands at the other directories, and the pwsh denials.
 * @returns {Cell[]}
 */
export function committedCells() {
  const cells = [];
  for (const level of LEVELS)
    for (const command of COMMANDS)
      cells.push(cellFor("demo-root", command, level));
  for (const [cwdId, commands] of Object.entries(SUBSET_BY_CWD)) {
    for (const level of LEVELS)
      for (const command of commands)
        cells.push(cellFor(cwdId, command, level));
  }
  for (const level of LEVELS)
    for (const command of PWSH_COMMANDS)
      cells.push(cellFor("demo-root", command, level, PWSH));
  return cells;
}

/**
 * The full matrix: every command in every directory at every level, plus pwsh at the clone.
 * @returns {Cell[]}
 */
export function fullCells() {
  const cells = [];
  for (const cwd of CWDS)
    for (const level of LEVELS)
      for (const command of COMMANDS)
        cells.push(cellFor(cwd.id, command, level));
  for (const level of LEVELS)
    for (const command of COMMANDS)
      cells.push(cellFor("demo-root", command, level, PWSH));
  return cells;
}
