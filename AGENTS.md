# simpsonm09-org-ai-plugin working agreements

The shared OpenCode layer for the `simpsonm09-org` organization, and the Claude Code plugin that applies the same agent-access gate.

## Ground rules

- The layer contributes no MCP server. Reach a shared service through its CLI, documented in the `service-integrations` registry. Add a server only when no CLI covers the job.
- Keep `layer.json`, `package.json`, and `opencode.fragment.jsonc` in sync. The contract test checks them. The runtime file list in `layer.json` and `package.json` must match the runtime exactly; `tests/package-layout.test.ts` checks it.
- A skill id must match its directory and carry a non-empty third-person description.
- The gate decides in `gate.mjs` only. `index.ts`, `pi/index.ts`, and the Claude hook are adapters: they gather inputs and apply the answer. Do not add a rule to an adapter.
- Do not add segment analysis, verb tables, token-name checks, or other restrictions to the gate without an owner decision. The gate reads the first command, as the resolver does; that is documented as a known limit.
- Keep the registry general and portable. Defer accounts, boards, workspaces, clusters, identities, and bundles to the personal layer.
- No personal content, secret, or machine path is committed. Tests use a fixture token and temporary workspaces, never the real broker or a sibling clone.
- Never run `git push`, `gh`, or `curl` from a test. The fixture stubs the broker and the remotes are only names in a fixture's git config.

## Commands

- `just install`, `just lint`, `just test`, `just verify`.

## Repo facts

- Language and toolchain: TypeScript, Node, and `@opencode/plugin`.
- The decision: `gate.mjs` (`decideShell`, `gateShellEdit`). OpenCode applies it through `index.ts`; Claude Code through `hooks/lib/claude.mjs`; the launcher re-runs it in `bin/with-gh-token.mjs`.
- Worktrees under `projects/worktrees` are fleet repositories in both harnesses. Four changes from HEAD are intended, and the README lists them under "Differences from the previous gate": a worktree is gated as its repository, a letter-case variant of a clone path resolves to the clone, a junction into a clone is gated as that clone, and an executable spelling of gh or git (`gh.exe`, a full path) is gated as the plain name.
- The resolver and broker are read from the repo-standard clone in the workspace, through `access.mjs`. The tests use a frozen copy at `tests/fixtures/installed-agent-access.mjs`.
- The differential's golden file, `tests/fixtures/parity-golden.json`, records HEAD's gate outcomes. A scratch runner outside this repository recorded it, and it is not regenerated to match new behavior. A change to a golden entry is a decision change and needs an owner decision.
- Pi: `pi/index.ts` is the extension, named in `package.json`'s `pi.extensions`. It registers one `tool_call` handler, and `hooks/lib/pi.mjs` maps it onto the Claude adapter. Its `ask` and `AGENT_ACCESS_PI_ASK` rules are in the README's "Pi coding agent build".
- `maxstack` composes this layer above the PStack base and below the personal layer.
- Skills: `service-integrations`, `repo-tasks`, `repo-standard`, `local-services`, `review-session-history`, `machine-inventory`.
- The README covers the contents, the gate, the layering, the known limits, and the layer contract.

## Skills

The plugin registers the skills under `skills/`. General best practices come from the PStack base. This layer adds the shared integration skills.

## Pi extension

The Pi build gates the `bash` tool through the same decision. Its known limits, which the README also lists:

- A child `pi --mode rpc` does not inherit a parent's `-e` extension. The package must be in the saved settings `packages` list for a child to load the gate.
- `pi -p` inside bash passes, because the gate reads the first word only.
- The ask switch reaches child processes. The launcher wrapper sets `AGENT_ACCESS_PI_ASK` for the whole Pi process tree. The agent's bash can start a child `pi` with the variable in its command, and that child's asks are rewritten. Denials still apply to it.
- The edit and write tools can change extension files, and they are not gated.
- Extensions run with full privileges in the Pi process, and the gate has no time budget of its own.
- rpc mode: `ctx.hasUI` is true, `ctx.mode` is `"rpc"`, and `ui.confirm` exists, but nobody answers. The confirm resolves `false` after 3000 ms, so without `AGENT_ACCESS_PI_ASK=allow` every ask is refused after a 3 s stall.
- Not measured against a live Pi: the rewrite of `event.input.command` taking effect, and the `ui.confirm` signature.
