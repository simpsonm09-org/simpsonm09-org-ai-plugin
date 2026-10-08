# simpsonm09-org-ai-plugin

The shared OpenCode layer for the `simpsonm09-org` organization, and the Claude Code plugin that applies the same agent-access gate.

The original lives in `simpsonm09-org/simpsonm09-org-ai-plugin`; work happens on the personal fork. See [`repo-standard`](https://github.com/simpsonm09-org/simpsonm09-repo-standard).

It is CLI-first and contributes no MCP server. It contributes the shared skills every repository in the organization should have, and nothing personal. The `service-integrations` registry is general and portable; accounts, boards, workspaces, clusters, identities, and bundles live in the personal layer, which the org skills defer to. `maxstack` composes this layer above the faithful PStack port and below the personal layer.

## Contents

- `layer.json` describes the layer: its name, kind, config fragment, and plugin files.
- `opencode.fragment.jsonc` is the fragment `maxstack` merges into the workspace config.
- `index.ts` and `package.json` are the OpenCode plugin entrypoint. `index.ts` is an adapter; the rules are in `gate.mjs`.
- `gate.mjs` is the shared decision for one shell command. Both harnesses use it, and nothing else decides.
- `access.mjs` loads the repo-standard resolver and token broker, caches tokens per repository, and bounds each call with a timeout.
- `lib/` holds the fleet lookup (`fleet.mjs`), the trusted-workspace rule (`location.mjs`), the Git Bash lookup (`bash.mjs`), the program-name rule that makes `gh.exe` and `GIT` the plain names (`program.mjs`), and the hook time budget (`budget.mjs`).
- `.claude-plugin/plugin.json` and `hooks/` are the Claude Code plugin: a `PreToolUse` gate for the Bash and PowerShell tools, and a `SessionStart` line.
- `.github/plugin/plugin.json` and `hooks/copilot-hooks.json` are the GitHub Copilot CLI build of the same plugin. `hooks/lib/copilot.mjs` is its adapter, and `hooks/lib/runtime.mjs` picks the Claude or Copilot adapter from the hook's first argument.
- `bin/with-gh-token.mjs` is the launcher that runs an allowed `gh` command with a token. `bin/payload.mjs` is the payload it reads.
- `skills/` holds the skills the plugin registers.

## The agent access gate

A shell command that runs in a fleet repository is gated by the repository's agent access level, read from the repo-standard catalog. A fleet repository is a clone at `<workspace>/projects/repos/<repo>`, or a worktree at `<workspace>/projects/worktrees/<name>`, which resolves to its clone through git's common directory. Anything else is not gated.

The decision is the resolver's, made from the first command only: a denied command is rewritten (OpenCode) or denied (Claude Code), and an allowed `gh` command gets a GitHub App token for its repository in its environment (`GH_TOKEN`). A write the gate cannot resolve is denied; a read it cannot resolve passes.

- **OpenCode** calls `gateShellEdit` from `gate.mjs` in the `create.before` shell hook. It rewrites a denied command and sets `GH_TOKEN` directly.
- **Claude Code** calls `decideShell` from `gate.mjs` in a `PreToolUse` hook for the `Bash` and `PowerShell` tools. A deny is a deny. An allowed `gh` command in the Bash tool is rewritten to run through the launcher, as `allow` when it is clearly a read (`pr view|list|checks|diff|status`, `issue view|list|status`, `run view|list|watch`, `repo view`, `release view|list`, `workflow view|list`, `search`, `status`, and `api` with no method, field, or input flag) and as `ask` otherwise. The `updatedInput` keeps every original tool input field. A `gh` command in the PowerShell tool is denied with a hint to use the Bash tool, because the launcher runs under Git Bash.
- **The launcher** (`bin/with-gh-token.mjs`) takes its workspace from its own real file location, not from the environment or the working directory. It checks the payload's workspace and repository, runs the same `decideShell` from its own working directory, and runs the command only for an allowed `gh` command for that repository. It mints the token for that repository, cached per repository, and runs the whole command in Git Bash with `GH_TOKEN` in the child's environment. On Windows the Git Bash is `CLAUDE_CODE_GIT_BASH_PATH` when that is set (it must exist), else the Git Bash beside `git` on `PATH`. If neither exists the launch is refused, never run under a bare `bash`. On other platforms the launcher runs `bash` from `PATH`.
- **The SessionStart hook** adds the same line OpenCode adds: `agent-access: the repository <repo> has agent access level "<level>".`

Fail-closed behavior on the Claude side: the PreToolUse hook exits 2 with a short reason on any internal failure. The SessionStart hook never blocks a session. A write with no working directory is denied, as is a write when the plugin is not in a trusted layout and so cannot find the resolver. The git and child-process calls the plugin makes are bounded (5 to 20 seconds each). The PreToolUse hook has a 40 second internal budget and a 45 second outer kill, both inside the 60 second timeout in `hooks/hooks.json`; the SessionStart hook has 15 and 20 seconds inside its 30 second timeout. When the budget runs out, or the outer kill fires, a write is denied and a read passes. The exceptions are listed under Known limits.

The Claude hook also denies a command that runs the launcher as its program, so the agent cannot skip the prompt by calling it directly. This is a cheap check on the program position, and the launcher's own decision is the control.

## Plugin and skills

The layer is configuration and a plugin at the same time. `maxstack`'s `Install-Workspace.ps1` merges the fragment into `opencode.jsonc` and copies the files named in `layer.json` into `.opencode/plugins/simpsonm09-org-ai-plugin`, where OpenCode loads the plugin. The plugin registers every `skills/<id>/SKILL.md` through `ctx.skill.transform`. The same tree, reached through a junction such as `.claude/plugins/<name>`, is the Claude Code plugin.

| Skill | Purpose |
| --- | --- |
| `service-integrations` | The general integration registry: which CLI owns an external-service job, the command, and the best practices. |
| `repo-tasks` | Run, build, test, or verify a repository through its `justfile`. |
| `repo-standard` | The gates, the definition of done, and the branch and pull request flow. |
| `local-services` | The container stack on this machine: Docker, Portainer, Infisical, and DbGate. |
| `review-session-history` | Mine stored sessions for recurring corrections, cluster and rank the themes, and route each to a named skill edit. |
| `machine-inventory` | The fleet machine classes: id, role, storage class, and capability flags, from the `simpsonm09-machine-inventory` records. |

To add a skill, create `skills/<id>/SKILL.md` with `name` and `description` frontmatter. The plugin picks it up on the next install and restart.

## How it gets loaded

This repository is not installed on its own. [`simpsonm09-maxstack`](https://github.com/simpsonm09-org/simpsonm09-maxstack)'s `scripts/Install-Workspace.ps1 -Apply` copies it to `<workspace>/.opencode/plugins/simpsonm09-org-ai-plugin` and links `<workspace>/.claude/plugins/simpsonm09-org-ai-plugin` to that copy.

- OpenCode needs no setting. It finds the workspace `.opencode` folder by walking up from the repository or worktree.
- Claude Code must be started with `--plugin-dir <workspace>/.claude/plugins`. In T3 Code that goes in the Claude provider instance's "Launch arguments". Without it a Claude Code session has neither the skills nor the access gate.

maxstack's [`docs/t3-setup.md`](https://github.com/simpsonm09-org/simpsonm09-maxstack/blob/main/docs/t3-setup.md) is the full reference. A new session is needed after each install.

## GitHub Copilot CLI build

The same folder is a GitHub Copilot CLI plugin. Copilot reads `.github/plugin/plugin.json`, whose `"hooks"` key names `hooks/copilot-hooks.json`, so Copilot runs the Copilot hooks and not `hooks/hooks.json`. The name and version match `.claude-plugin/plugin.json`, and `tests/copilot-plugin.test.ts` checks that.

Load it with the plugin folder, which is the directory that holds `.github/plugin/plugin.json`:

```bash
copilot --plugin-dir <workspace>/projects/worktrees/simpsonm09-org-ai-plugin-copilot plugin list
copilot --plugin-dir <workspace>/projects/worktrees/simpsonm09-org-ai-plugin-copilot
```

The gate trusts only the layouts in `lib/location.mjs`, so load a checkout under `projects/repos` or `projects/worktrees`, or the installed `.opencode/plugins` copy. A copy in another directory trusts no workspace, so the gate denies every write it cannot check.

The hooks file (`hooks/copilot-hooks.json`) uses the camelCase event keys, flat entries, and `version: 1`. Each entry has `bash` and `powershell` command keys. The `preToolUse` entry has `"matcher": "powershell|bash"`, and the `sessionStart` entry has none. The contract below was measured on Copilot CLI 1.0.93 on Windows with a probe plugin, and the tests use those payloads verbatim (`tests/copilot-hooks.test.ts`).

**Input.** The `preToolUse` payload is `{"sessionId", "timestamp", "cwd", "toolName", "toolArgs"}`. The shell's dialect is the tool name: `powershell` is read as PowerShell, and `bash` as Bash. The `sessionStart` payload is `{"sessionId", "timestamp", "cwd", "source", "initialPrompt"}`.

With the PascalCase keys (`PreToolUse`) Copilot sends Claude's payload instead, where a PowerShell call is reported as `"tool_name":"Bash"`. The dialect cannot be known from that, so the Copilot adapter denies such a call with a reason that names the cause. The hooks file must keep the camelCase keys.

**Output.** The hook answers with one JSON object on stdout, and exits 0.

- `{"permissionDecision":"allow","modifiedArgs":{...toolArgs,"command":"<new>"}}` rewrites the call. `modifiedArgs` keeps every field of `toolArgs`, such as `description`, and replaces `command`. The rewritten command ran. Our allow answer also carries a `permissionDecisionReason`, which the measurement did not show.
- `{"permissionDecision":"deny","permissionDecisionReason":"..."}` shows the agent `Denied by preToolUse hook: <reason>`.
- A call the gate does not govern prints nothing.
- Exit code 2 denies the call and shows `Denied by preToolUse hook from "<plugin>" (hook errored)`. A malformed payload exits 2.

`sessionStart` prints `{"additionalContext":"..."}` for a fleet repository, and nothing elsewhere. Its stdout reached the model. It never exits non-zero.

**Rewrites.** A gh call is rewritten through the launcher, as on Claude. The PowerShell tool gets a PowerShell line, `& '<node>' '<launcher>' '<payload>'`. The Bash tool gets the POSIX form. The launcher then runs the command in the shell the tool used, and the payload carries the original command in base64.

**A second pass.** Copilot can run the hook again on a command it has already rewritten, so the hook sees its own launcher line. This was measured once: a `gh api` call's rewrite came back to the hook, and the hook denied it. The trigger is not known. The hook handles a launcher line this way. It must have exactly the shape of its own rewrite, for the same dialect: a PowerShell call operator or none, a node path, a launcher path, and one base64 argument, with nothing before or after. The hook decodes the payload and takes only its `command`. It then decides that command again, in the current call's directory, with the current dialect, workspace, repo, and access level. The line is allowed only when the rewrite it produces is byte-for-byte the line. The result is `allow`, or `ask` for a write, with no `modifiedArgs`, which is the decision of the first pass. Any other launcher line is denied with `the GitHub token launcher is not for direct use`. That includes a different repo or workspace, a different launcher path, a trailing command, a tampered or undecodable payload, and a command the gate would deny or not rewrite. The second pass grants nothing the agent could not get by sending the payload's command. Claude keeps its flat denial of any launcher line.

**Environment.** In the hook process both `COPILOT_PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` are set. The tool's own shell does not have them.

**Several plugins.** Hooks from several plugins run in sequence, and a later hook sees the command as an earlier one rewrote it. The gate decides on the command it receives, so a rewrite by another plugin is what it reads. Its own rewrite is not re-checked by a later hook.

The Copilot limits are listed under Known limits.

## Differences from the previous gate

The gate resolves a working directory to its real path before it names the repository. Four cases differ from the previous gate on `main`. Each is intended and has a test. Every other committed cell gives the same decision as `main`: the OpenCode command text and environment match byte for byte, and the Claude hook gives the same action (`tests/parity.test.ts`).

- **A worktree is gated as its repository.** A worktree at `<workspace>/projects/worktrees/<name>` resolves to its clone through git's common directory, so it gets the clone's level. Before, a worktree was not a fleet repository, and its commands passed. Covered by `tests/fleet.test.ts`, `tests/index.test.ts`, and the `worktree` cells of `tests/parity.test.ts`.
- **A letter-case variant resolves to the real repository.** On Windows, `projects\REPOS\DEMO-REPO` names the clone `demo-repo`. Before, the name came from the path as typed, so the same commands were decided for a repository called `DEMO-REPO` at the default level, not the clone's level. Covered by a test in `tests/fleet.test.ts` and the `case-variant` cells of `tests/parity.test.ts`. Both run only on a case-insensitive file system, so on Linux they are skipped.
- **A junction from outside `projects/repos` into a clone is gated as that clone.** A junction or symlink that points at `projects/repos/demo-repo` resolves to `demo-repo`. Before, its path named no repository, so its commands passed. Covered by `tests/fleet.test.ts` and the `junction` cells of `tests/parity.test.ts`. The fleet test is skipped where a junction cannot be created.
- **An executable spelling of gh or git is gated as the plain name.** The first shell word is read the way Bash and PowerShell read it: adjacent quoted and unquoted pieces join into one word (`"gh".exe`, `g"h"`, `'g'it`), and a backslash escapes in Bash but separates a path in PowerShell. The gate tries both readings, so `g\h`, `gh\.exe`, `.\gh.exe`, `C:\tools\gh.exe`, and `C:/Program\ Files/GitHub\ CLI/gh.exe` all name gh. A path with spaces is one word only when it is quoted, or when each space is escaped in Bash, so an unquoted `C:\Program Files\GitHub CLI\gh.exe` names no program in either reading. The program name then drops the directory, trailing dots and spaces, case, and one trailing `.exe`, `.cmd`, `.bat` or `.com`. So `gh.exe`, `GH`, `"gh".exe`, `./gh`, `gh.exe.`, and `"gh.exe "` get the decision of the plain name, and so does the same spelling of `git`. A leading tab is handled as a leading space is. An allowed gh call gets its token. Before, a quoted or escaped spelling was not gated at all, and an allowed gh call got no token and ran under the user's own login. Covered by `tests/spelling.test.ts`, `tests/gate.test.ts`, and `tests/with-gh-token.test.ts`.

## Known limits

- **The gate reads only the first command.** A chained or prefixed command is not analysed: `cd x && git push origin main` and `FOO=1 git push origin main` are decided by their first command. This is the same as before the Claude side was added.
- **Scripts a command runs are not read.** A command that runs `bash scripts/x.sh`, or any other program, is decided by its own first word, not by what the program does.
- **Only the first word is read, and a wrapper is not unwrapped.** `env gh ...`, `command gh ...`, `& gh ...`, `cmd /c gh ...`, `powershell -c "gh ..."`, and a script that calls gh are decided by their own first word, so they run under the user's own login. A gh alias or extension is decided by the word after `gh`, which the resolver does not classify, and gh then runs what the alias names. The first word is normalised as the bullet on spellings above describes; nothing else about it is read. A first word with an unquoted `$`, a backtick, or `(` is left as typed, so `$gh pr merge 1`, `$(gh) pr merge 1`, and `(gh pr merge 1)` are decided by their own first word. Variables, command substitution, and glob characters are not expanded, so `$x pr merge 1` and `g? pr merge 1` are not read as gh; a `$` or a backtick inside double quotes is not read either. A `gh` joined to the next command or to a redirection with no space, such as `gh;gh pr merge 1`, `gh&&gh pr merge 1`, or `gh>out.txt pr merge 1`, is one word that is not a gh command, so it gets no token and passes at every level.
- **A local script named `git` or `gh` is decided as that program.** The program name is the last path segment, so `./scripts/git push origin main` is decided as `git push origin main`, and `./scripts/gh pr merge 1` gets a gh token, as the real gh would. The gate cannot tell the script from the program, so the script is governed by the program's rules.
- **A global flag before the subcommand hides the subcommand.** The resolver reads the word after `gh` or `git`, so `gh -R owner/repo pr merge 1` is an unclassified command: it is allowed at every level and gets a token. `git -C path push origin main` is allowed at every level and runs under the user's own login. The gate adds no rule for this, because a rule that reads past flags is segment analysis, which needs an owner decision.
- **A space or a tab before `gh` removes the token.** The token test is on the first word after the spelling is normalised, as it was on `main`, so ` gh pr merge 1` or a tab before it gets no token and no launcher. Where the resolver allows the write it runs under the user's own login, in both harnesses. A tab and a space behave identically. The parity golden pins ` gh pr list` to this behaviour, so it is not changed here.
- **The resolver allows several write verbs at low levels.** At `none`, `read`, and `propose`, the resolver allows `gh repo delete`, `gh secret set`, `gh pr comment`, `gh release create`, and `gh workflow run`. OpenCode gives these commands the App token without a prompt. Claude Code asks first, because its read-only list does not include them. The gate adds no verb table of its own; these answers are the resolver's.
- **The ask prompt shows at most 300 characters of a command.** A longer command is cut with `...`, so the person approving it does not see all of it.
- **A same-user process can reach the token broker.** The broker and its App key are in the user's profile, and the hook denies only a direct run of the launcher. Anything else running as the same user can mint a token.
- **The token is in the launched command's environment**, so that command can print it. The launcher never prints it, and it is never written to a file or put in the command text.
- **If `node` is not on the hook shell's PATH, the Claude hook does not run.** The hook command is `node "${CLAUDE_PLUGIN_ROOT}/hooks/pre-tool-use.mjs"`. When node cannot be found, the shell fails before any hook code runs, Claude Code treats that failure as non-blocking, and the call runs without the gate.
- **A hook timeout fails open.** Claude Code runs a hook past its timeout as allowed. The internal budget stops the hook before that, but a hook killed by Claude Code's own timeout is not denied.
- **A hard-killed launcher on Windows may leave its child running.** The launcher stops its child on SIGINT, SIGTERM, and SIGHUP, and on normal exit. A forced kill cannot run that handler.
- **The launched command has no time limit of the plugin's own.** A `gh` command that hangs runs until it exits or the launcher is stopped.
- **The Claude side mints nothing in the hook.** A token that cannot be minted is refused by the launcher at run time, not by the hook at decision time.
- **The resolver and the broker are not ours.** The resolver's catalog read runs git without a timeout, and the broker's HTTP calls have none. The launcher bounds a token mint at 20 seconds and gives up on it, but cannot cancel the call underneath.
- **Read-only `allow` is a prompt choice, not a control.** The gate decision is the same with `allow` or `ask`; only the prompt differs.
- **Copilot: a hook timeout is not measured here.** The Copilot docs summary says a `PreToolUse` hook that times out falls through to Copilot's normal permission flow, not to a deny. The hook has a 60 second `timeoutSec`, and the plugin answers at its 45 second outer kill, so the plugin's own deny comes first. The timeout behaviour itself has not been measured.
- **Copilot: the PowerShell rewrite is not yet measured live.** The `modifiedArgs` rewrite was measured with a POSIX-style command, and the new command ran. The PowerShell form of the rewrite is tested by running it through `powershell.exe` in `tests/copilot-powershell.test.ts`, not in a live Copilot session.
- **Copilot: a PowerShell gh call runs under Windows PowerShell 5.1.** The launcher starts `powershell.exe` on Windows (`pwsh` elsewhere) with `-EncodedCommand`. A double quote inside a single-quoted argument to a native command is not passed intact by 5.1: `'say "hi"'` reaches `gh` as `say hi` when `gh` is a `.cmd` shim. Not verified against the real `gh.exe`.
- **Copilot: the Git Bash lookup uses the Claude variable.** A Bash gh call on Windows still reads `CLAUDE_CODE_GIT_BASH_PATH` and then `git` on `PATH`. Copilot has no variable of its own here.
- **Copilot: the hook can run again on its own rewrite.** The trigger is not known, so a second pass is expected. The hook accepts only its exact rewrite of the payload's command, as described above, and denies everything else.
- **Copilot: a later hook can rewrite the command after this one.** Hooks from several plugins run in sequence, and a later hook sees this hook's rewrite. The gate does not run again on what a later hook changes.
- **Copilot: `ask` in a cloud agent run.** The Copilot docs summary says a cloud agent treats `ask` as `deny`. This is not measured here.

## MCP servers

The org layer contributes no MCP server. `opencode.fragment.jsonc` is empty. Every shared service is reached through a CLI documented in the `service-integrations` registry. Keep an MCP server for a job only when no CLI covers it, and add it on demand.

GitHub, Postman and its `newman` runner, library docs, browsers, Kubernetes, secrets, tool versions, container runtime, repository tasks, and scanning are handled by `gh`, `postman`, `newman`, `npx ctx7`, `@playwright/cli`, the `chrome-devtools` CLI, `kubectl`, `helm`, and `kustomize`, `infisical`, `mise`, `docker`, `just`, and `trivy`. The Agent Vault brokers a service credential to a tool through a local proxy, and the `with-secrets` and `with-vault` wrappers are the path to a brokered service. Code search uses the local `grep` tool, and repo tasks use `just`. See the `service-integrations` registry for the owner of each job and the `local-services` skill for the container stack. Accounts, boards, workspaces, clusters, identities, bundles, and personal services such as Discord and email live in the personal layer, which this layer defers to.

## Layering

Precedence is personal over org over the PStack base. A layer overrides a same-key server from a lower layer. `maxstack` records the repo and commit of every layer in `stack.lock.json`.

## Layer shapes

A layer can contribute configuration, a plugin, or both. This layer contributes a plugin and an empty config fragment. A layer that only contributes configuration needs no `index.ts`. Add a plugin entry when the layer has something to register, not before.

## Local checks

Install the pinned tools, then run what CI runs.

```bash
mise install
npm ci
mise run lint    # flint over the changed files; CI runs flint run --full
mise run test    # node --test over tests/
```

The tests need no sibling checkout. The resolver they run is a frozen copy of the installed `scripts/agent-access.mjs` in `tests/fixtures/installed-agent-access.mjs`. The differential in `tests/parity.test.ts` compares the current code with recorded HEAD outcomes in `tests/fixtures/parity-golden.json`. They cover the skill loader and the layer contract, the gate and its helpers, the fleet lookup against real git worktrees, the Claude hook and its entry points, the launcher's trust checks and a real Git Bash run, and the runtime's import graph.

## License

MIT. See [`LICENSE`](LICENSE).
