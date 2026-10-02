# simpsonm09-org-opencode

The shared OpenCode layer for the `simpsonm09-org` organization.

The original lives in `simpsonm09-org/simpsonm09-org-opencode-plugin`; work happens on the personal fork. See [`repo-standard`](https://github.com/simpsonm09-org/simpsonm09-repo-standard).

It is CLI-first and contributes no MCP server. It contributes the shared skills every repository in the organization should have, and nothing personal. The `service-integrations` registry is general and portable; accounts, boards, workspaces, clusters, and machine services live in the personal layer, which the org skills defer to. `maxstack` composes this layer above the faithful PStack port and below the personal layer.

## Contents

- `layer.json` describes the layer: its name, kind, config fragment, and plugin files.
- `opencode.fragment.jsonc` is the fragment `maxstack` merges into the workspace config.
- `index.ts` and `package.json` are the OpenCode plugin entrypoint.
- `skills/` holds the skills the plugin registers.

## MCP servers

The org layer contributes no MCP server. `opencode.fragment.jsonc` is empty. Every shared service is reached through a CLI documented in the `service-integrations` registry. Keep an MCP server for a job only when no CLI covers it, and add it on demand.

GitHub, Postman and its `newman` runner, library docs, browsers, Jira and Atlassian, Kubernetes, Jenkins, and Vault are handled by `gh`, `postman`, `newman`, `npx ctx7`, `@playwright/cli`, the `chrome-devtools` CLI, `acli`, `kubectl` and `helm`, the Jenkins CLI, and `vault`. Code search uses the local `grep` tool, and repo tasks use `just`. See the `service-integrations` registry for the owner of each job and the `local-services` skill for the container stack. Accounts, boards, workspaces, clusters, and personal services such as Discord and email live in the personal layer, which this layer defers to.

## Plugin and skills

The layer is configuration and a plugin at the same time. `maxstack`'s `Install-Workspace.ps1` merges the fragment into `opencode.jsonc` and copies the files named in `layer.json` into `.opencode/plugins/simpsonm09-org-opencode`, where OpenCode loads the plugin. The plugin registers every `skills/<id>/SKILL.md` through `ctx.skill.transform`.

| Skill | Purpose |
| --- | --- |
| `service-integrations` | The general integration registry: which CLI owns an external-service job, the command, and the best practices. |
| `repo-tasks` | Run, build, test, or verify a repository through its `justfile`. |
| `repo-standard` | The gates, the definition of done, and the branch and pull request flow. |
| `local-services` | The container stack on this machine: Docker, Portainer, Infisical, and DbGate. |

To add a skill, create `skills/<id>/SKILL.md` with `name` and `description` frontmatter. The plugin picks it up on the next install and restart.

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

The tests cover the skill loader and the layer contract: that `layer.json` names an existing config fragment, that its `files` list matches `package.json`, and that the fragment contributes no MCP server.

## License

MIT. See [`LICENSE`](LICENSE).
