---
name: repo-tasks
description: Use when you need to run, build, test, lint, or verify a repository in this workspace, or when asked how to run a repo. Points at the repository justfile as the single entry point for humans and agents.
---

# Repository tasks

Repositories in this workspace expose a `justfile` at the root. `just` is the one entry point for a human or an agent. It is a thin wrapper: every recipe delegates to an npm script or a script under `scripts/`, so the logic lives in one place and the recipe works on Windows, macOS, and Linux.

## Run a task

1. Look for `justfile` at the repository root.
2. Run `just --list` to see the recipes.
3. Run the recipe, for example `just verify`.

Common recipe names:

| Recipe | Does |
| --- | --- |
| `just verify` | The full local check: typecheck, build, test |
| `just test` | Tests only |
| `just build` | Build the artifacts |
| `just typecheck` | Types only |
| `just lint` | The repository linters |
| `just setup` or `just install` | Install dependencies |
| `just prune` | Prune remote-tracking refs and delete local branches merged into `main` |

Arguments are positional. For example, `just emit config.json out.json`.

## When there is no justfile

Fall back to the commands in the repository README or `mise.toml`. Prefer `just` when it exists.

## Rules for authors

- A recipe calls `npm`, `node`, or another portable executable.
- Do not put shell operators (`&&`, `;`, `|`), `$VAR`, or Unix-only commands in a recipe.
- Put multi-step logic in a Node or Python script under `scripts/` and call it from the recipe.
- Keep the recipe set small and conventional so an agent can guess the name.
- `just` is pinned in `mise.toml`. Run `mise install` to get it.
