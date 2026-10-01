---
name: service-integrations
description: Use when a task needs an external service in this workspace, such as library documentation, code search, GitHub, Postman, a browser, Jira, or a repository command. This skill is the integration registry. It points to the CLI that owns each job.
---

# Service integrations

This skill is the integration registry for the org layer. Reach a service through a command line tool. A service has one CLI owner. Use an MCP server only when no CLI covers the job, and keep it off by default.

## Pick the owner

| Job | Owner | Command | Notes |
| --- | --- | --- | --- |
| GitHub issues, pull requests, Actions, releases | `gh` | `gh pr view`, `gh issue list`, `gh api` | Authenticated as `simpsonm09`. |
| Public GitHub code search | `gh search code` | `gh search code "<pattern>" --language <lang>` | Legacy engine, no regex, default branch only, files under 384 KB. |
| Postman collections, environments, specs | `postman` | `postman collection get <id>`, `postman describe` | Install with `npm install -g postman-cli`, then `postman login`. |
| Library, framework, SDK docs | `npx ctx7` | `npx ctx7 library <name> "<topic>"` | Anonymous works. `npx ctx7 login` raises the rate limit. |
| Browser automation and capture | `@playwright/cli` | `playwright-cli open <url>`, `goto`, `click`, `screenshot`, `pdf`, `attach --extension` | Purpose-built for coding agents. `attach --extension` reaches a logged-in browser and keeps persistent sessions. |
| Chrome performance and debugging | `chrome-devtools` CLI | `chrome-devtools navigate_page`, `take_screenshot`, `lighthouse_audit` | CLI over the same daemon as the MCP. It covers most tools. |
| Jira and Atlassian issues, JQL search, comments, transitions | `acli` | `acli jira workitem view/search --jql`, `comment-create`, `workitem transition` | Official and maintained. macOS `brew install atlassian/homebrew-acli/acli`, Linux apt or yum, Windows binary download. |
| Discord, including messages, channels, roles, members, threads, DMs, and webhooks | `discli` | `discli message send <channel> "<text>"`, `discli server list` | See the `discord` skill in the personal layer for the token, profiles, and the command set. |
| Local containers | `docker` | `docker ps`, `docker logs`, `docker restart`, `docker compose -f services/<name>/docker-compose.yml up -d` | Docker runs in WSL only, never in Windows. See the `local-services` skill. |
| Containers and Compose stacks in a GUI | Portainer CE | `https://localhost:9443` | First run needs the setup token from `docker logs portainer`. See the `local-services` skill. |
| Secrets, the source of truth | Infisical | `infisical login`, `infisical export`, or `http://localhost:8088` | Loaders: the workspace `.envrc` in WSL, `scripts/Import-Secrets.ps1 -Apply` on Windows. See the `local-services` and `secrets` docs. |
| Local code search | the `grep` tool | `grep` with a literal or a regex | Prefer this inside the repo. |
| Run, build, test, verify a repository | `just` | `just <recipe>` | See the `repo-tasks` skill. |

## GitHub via `gh`

Check the session with `gh auth status`. Sign in with `gh auth login`.

| Need | Command |
| --- | --- |
| List open issues | `gh issue list --state open` |
| Read an issue | `gh issue view <number> --comments` |
| List pull requests | `gh pr list` |
| Read a pull request | `gh pr view <number> --comments` |
| Pull request diff | `gh pr diff <number>` |
| Pull request checks | `gh pr checks <number>` |
| Merge a pull request | `gh pr merge <number> --merge --delete-branch` |
| Search code across public GitHub | `gh search code "<pattern>"` |
| Search issues or pull requests | `gh search issues "<query>"` |
| Any REST call | `gh api <endpoint>` |

When you land a pull request, merge it and delete the head branch in one step. `--delete-branch` deletes the remote and the local branch. The repository's "automatically delete head branches" setting removes the branch on the remote only.

## Postman via `postman`

Install once with `npm install -g postman-cli`. Sign in with `postman login` (browser) or `postman login --with-api-key $env:POSTMAN_API_KEY`, then confirm with `postman whoami`. Commands that read the Postman cloud need a login. Commands that read local files do not.

| Need | Command |
| --- | --- |
| List workspaces | `postman workspace list` |
| Read a workspace | `postman workspace get <id>` |
| List collections | `postman collection list` |
| Fetch a collection | `postman collection get <id>` |
| List environments | `postman environment list` |
| Read an environment | `postman environment get <id>` |
| Read one variable | `postman environment var get <envId> <key>` |
| List specifications | `postman spec list` |
| Read a specification | `postman spec get <id>` |
| Search entities | `postman search collections "<query>"` |
| Aggregate context for a coding agent | `postman describe` |
| Run a collection | `postman collection run <path>` |
| Send a one-off request | `postman request <method> <url>` |

Add `--json` for machine-readable output. `postman workspace pull` writes a workspace's elements to disk when you want the files, not a listing.

## Library docs via `ctx7`

Resolve the library to a Context7 ID, then fetch the docs for the question.

```bash
npx ctx7 library next.js "route handlers"
npx ctx7 docs /vercel/next.js "route handlers"
```

Prefer `ctx7 docs` over a web search for library, framework, SDK, and CLI questions. Skip the resolve step when you already know the library ID.

## Browser via `@playwright/cli`

`playwright-cli` is the browser owner for automation and capture. Install it once, then drive a page.

```bash
playwright-cli open <url>
playwright-cli goto <url>
playwright-cli click <selector>
playwright-cli screenshot --full-page <url> shot.png
playwright-cli pdf <url> page.pdf
```

`playwright-cli attach --extension` attaches to a browser you are already logged in to, which reaches pages that block a fresh session. It keeps persistent state across commands.

## Chrome performance and debugging via `chrome-devtools`

The `chrome-devtools` CLI runs over the same daemon as the MCP server and covers most of its tools. Use it for navigation, screenshots, performance traces, and Lighthouse.

```bash
chrome-devtools navigate_page <url>
chrome-devtools take_screenshot
chrome-devtools lighthouse_audit
```

## Jira and Atlassian via `acli`

`acli` is the official Atlassian CLI. It owns Jira issues, JQL search, comments, and transitions.

```bash
acli jira workitem view <key>
acli jira workitem search --jql "project = PROJ AND status != Done"
acli jira workitem comment-create <key> --body "text"
acli jira workitem transition <key> --status Done
```

## Code search

Two owners, split by scope. Use the local `grep` tool for anything inside the repo. Use `gh search code "<pattern>"` for public GitHub, remembering its limits. There is no regex and only the default branch is searched.

## Repository tasks

For run, build, test, lint, or verify, use `just`. See the `repo-tasks` skill for the recipe names and the authoring rules.

## MCP exceptions, documented but not installed

No MCP server is installed by default. These three are the only jobs where an MCP server is the sole path. Add one only when a task needs it, and keep it off by default.

| Job | MCP | Why MCP is the only path | When to add |
| --- | --- | --- | --- |
| Interactive debugging, breakpoints, stepping, eval | `microsoft/DebugMCP` | The debugger primitives are MCP tools. The `debugmcp` CLI only installs adapters and configures agents. | When a debugging task needs stepping, not just a repro. |
| Natural-language and cloud browser automation | Stagehand or Browserbase | No CLI exists. The natural-language tools and cloud sessions are MCP-only. | When Browserbase credentials exist and the task needs natural-language control. |
| DevTools extension and service-worker tools | `chrome-devtools` MCP | The CLI excludes a few commands, including `wait_for` and `fill_form`. | Only when one of those commands is needed. |

## Rules

- A service has one CLI owner. Use the owner the table names instead of a second path to the same service.
- Use an MCP server only when no CLI covers the job. Keep it off by default and turn it on for the task that needs it.
- A secret comes from the environment, as `$env:POSTMAN_API_KEY` on Windows or `$POSTMAN_API_KEY` in WSL. Never write the value into a file.
- The workspace MCP servers are composed from the org and personal layers. The full list, prerequisites, and removal notes are in `maxstack/docs/mcp.md`.
