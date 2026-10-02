# simpsonm09-org-opencode working agreements

The shared OpenCode layer for the `simpsonm09-org` organization.

## Ground rules

- The layer contributes no MCP server. Reach a shared service through its CLI, documented in the `service-integrations` registry. Add a server only when no CLI covers the job.
- Keep `layer.json`, `package.json`, and `opencode.fragment.jsonc` in sync. The contract test checks them.
- A skill id must match its directory and carry a non-empty third-person description.
- Keep the registry general and portable. Defer accounts, boards, workspaces, clusters, and machine services to the personal layer.
- No personal content, secret, or machine path is committed.

## Commands

- `just install`, `just lint`, `just test`, `just verify`.

## Repo facts

- Language and toolchain: TypeScript, Node, and `@opencode/plugin`.
- `maxstack` composes this layer above the PStack base and below the personal layer.
- Skills: `service-integrations`, `repo-tasks`, `repo-standard`, `local-services`.
- The README covers the contents, the layering, and the layer contract.

## Skills

The plugin registers the skills under `skills/`. General best practices come from the PStack base. This layer adds the shared integration skills.
