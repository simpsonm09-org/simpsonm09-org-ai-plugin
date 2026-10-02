---
name: service-integrations
description: Use when a task needs an external developer service in this workspace, such as library documentation, code search, GitHub, Postman, a browser, Jira, Kubernetes, Jenkins, Vault, or secrets. This is the general integration registry. It names the CLI that owns each job and defers accounts, boards, workspaces, and clusters to the personal layer.
---

# Service integrations

This skill is the general integration registry for the org layer. Reach a service through a command line tool. A service has one CLI owner. Use an MCP server only when no CLI covers the job, and keep it off by default.

The registry is general and portable. It names the owner and the command. Accounts, boards, workspaces, clusters, and machine services are personal and live in the personal layer. See [Personal layer](#personal-layer).

## Pick the owner

| Job | Owner | Command | Install |
| --- | --- | --- | --- |
| GitHub issues, pull requests, Actions, releases | `gh` | `gh pr view`, `gh issue list`, `gh api` | winget, apt, or the GitHub release |
| Public GitHub code search | `gh search code` | `gh search code "<pattern>" --language <lang>` | with `gh` |
| Local code search | the `grep` tool | `grep` with a literal or a regex | built in |
| Postman collections, environments, specs | `postman` | `postman collection get <id>`, `postman describe` | `npm install -g postman-cli` |
| Postman collection runs, local and CI | `newman` | `newman run <collection.json>` | `npm install -g newman` |
| Library, framework, SDK docs | `npx ctx7` | `npx ctx7 library <name> "<topic>"` | `npx` |
| Browser automation and capture | `@playwright/cli` | `playwright-cli open <url>`, `goto`, `click`, `screenshot`, `pdf`, `attach --extension` | `npm install -g @playwright/cli` |
| Chrome performance and debugging | `chrome-devtools` CLI | `chrome-devtools navigate_page`, `take_screenshot`, `lighthouse_audit` | `npm install -g chrome-devtools` |
| Jira and Atlassian issues, JQL search, comments, transitions | `acli` | `acli jira workitem view/search --jql`, `comment-create`, `workitem transition` | official binary |
| Kubernetes objects | `kubectl` | `kubectl get`, `kubectl apply -f`, `kubectl logs` | winget, apt, or the release |
| Kubernetes packaging | `helm` | `helm upgrade --install`, `helm template` | winget, apt, or the release |
| Kubernetes manifest rendering | `kustomize` | `kustomize build <dir>` | winget or the release |
| Jenkins jobs, builds, and logs | the Jenkins CLI | `java -jar jenkins-cli.jar -s <url> build <job>` | fetched from the controller |
| Secrets in Vault | `vault` | `vault kv get secret/<path>` | winget, apt, or the release |
| Secrets, the workspace source of truth | `infisical` | `infisical login`, `infisical export` | npm or the release |
| Repository tasks | `just` | `just <recipe>` | `mise install` in the repository |
| Pinned tool versions | `mise` | `mise install`, `mise exec -- <tool>` | the mise installer |
| Container runtime | `docker` | `docker ps`, `docker logs` | WSL engine |
| Dependency, secret, and misconfig scan | `trivy` | `trivy fs --scanners vuln,secret,misconfig .` | winget, apt, or the release |

Install is the per-machine step. Prefer `winget` on Windows and `apt` in WSL, with `scoop` as the Windows fallback when no winget entry exists.

The machine's container stack has a console and no CLI. Portainer CE, DbGate, and the Infisical console are documented in the `local-services` skill, with their addresses kept in the personal layer.

## Personal layer

The general owner is here. The concrete value is not. The personal layer holds the account, board, workspace, cluster, and machine specifics, and the personal services that sit below the org boundary.

- Accounts and sites: the GitHub account, the Jira site and board, the Postman workspace.
- Infrastructure: the Kubernetes context, the Vault address and namespace, the Infisical project.
- Personal services: email through `himalaya`, phone notifications through `ntfy`, texting through `smsgate`, and Discord through `discli`.

See the personal layer skills `integrations-personal`, `discord`, and `dev-tools` in `simpsonm09-personal-opencode`.

## Best practices

- Use the owner in the table instead of a second path to the same service.
- Read a secret from the environment, as `$env:NAME` on Windows or `$NAME` in WSL. Never write the value into a file.
- Prefer `--json` when a script consumes the result.
- Prefer a CLI over an MCP server. Add an MCP server only when no CLI covers the job, and keep it off by default.
- Verify the tool before blaming a command: `--version`, `gh auth status`, `vault status`, `kubectl config current-context`.
- Never drive an interactive wizard from an agent. Configure the tool with individual commands and a config file.

## GitHub via `gh`

Check the session with `gh auth status`. Sign in with `gh auth login`. The personal layer records which account is in use.

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

## Postman and `newman`

`postman` owns the Postman cloud. `newman` runs an exported collection from a file, locally or in CI. Install `postman` with `npm install -g postman-cli` and sign in with `postman login` or `postman login --with-api-key $env:POSTMAN_API_KEY`, then confirm with `postman whoami`. Install `newman` with `npm install -g newman`.

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
| Run a collection from the cloud | `postman collection run <path>` |
| Run an exported collection offline | `newman run <collection.json> -e <env.json>` |

Add `--json` for machine-readable output. `postman workspace pull` writes a workspace's elements to disk when you want the files, not a listing. Name the personal workspace and environment in the personal layer.

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

`acli` is the official Atlassian CLI. It owns Jira issues, JQL search, comments, and transitions. The site and board are personal; see the personal layer.

```bash
acli jira workitem view <key>
acli jira workitem search --jql "project = PROJ AND status != Done"
acli jira workitem comment-create <key> --body "text"
acli jira workitem transition <key> --status Done
```

## Kubernetes via `kubectl`, `helm`, and `kustomize`

`kubectl` reads and writes cluster objects. `helm` manages releases. `kustomize` renders overlays. The context and cluster are personal; see the personal layer.

```bash
kubectl config current-context
kubectl get pods -A
kubectl apply -f manifest.yaml
kubectl logs <pod> --tail 100
helm upgrade --install <release> <chart> -n <namespace>
kustomize build overlays/dev
```

## Jenkins via the Jenkins CLI

The Jenkins CLI is a jar served by the controller. Fetch it from `<url>/jnlpJars/jenkins-cli.jar`, then authenticate with an API token from the environment rather than a password.

```bash
java -jar jenkins-cli.jar -s <url> -auth "$JENKINS_USER:$JENKINS_API_TOKEN" who-am-i
java -jar jenkins-cli.jar -s <url> -auth "$JENKINS_USER:$JENKINS_API_TOKEN" build <job>
java -jar jenkins-cli.jar -s <url> -auth "$JENKINS_USER:$JENKINS_API_TOKEN" console <build>
```

Never drive the Jenkins setup wizard from an agent.

## Vault via `vault`

`vault` reads and writes secrets in HashiCorp Vault. The address, namespace, and auth method are personal; see the personal layer.

```bash
vault status
vault kv get secret/<path>
vault kv put secret/<path> key=value
```

Prefer reading a value into the environment over passing it on a command line that lands in shell history.

## Secrets via `infisical`

The workspace loads its secrets from a self-hosted Infisical through the loaders, not by calling `infisical` directly. WSL loads the workspace `.envrc` through direnv; Windows runs `scripts/Import-Secrets.ps1 -Apply`. The address and project are personal; see the personal layer.

```bash
infisical login --method=universal-auth --plain --silent
infisical export --token "$TOKEN" --projectId "$INFISICAL_PROJECT_ID" --env dev --format json
```

## Code search

Two owners, split by scope. Use the local `grep` tool for anything inside the repository. Use `gh search code "<pattern>"` for public GitHub, remembering its limits. There is no regex and only the default branch is searched.

## Repository tasks

For run, build, test, lint, or verify, use `just`. Repositories pin their tool versions with `mise`, so run `mise install` first; `just` is one of the pinned tools. See the `repo-tasks` skill for the recipe names and the authoring rules.

## Scanning via `trivy`

`trivy` scans dependencies, secrets, and misconfiguration. CI runs it as the `security / trivy` gate. Run it locally before pushing.

```bash
trivy fs --scanners vuln,secret,misconfig .
```

See the `repo-standard` skill for the gate and its suppression file.

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
- A secret comes from the environment, as `$env:NAME` on Windows or `$NAME` in WSL. Never write the value into a file.
- Keep this registry general. Put the account, board, workspace, cluster, and machine value in the personal layer.
- The workspace MCP servers are composed from the org and personal layers. The full list, prerequisites, and removal notes are in `maxstack/docs/mcp.md`.
