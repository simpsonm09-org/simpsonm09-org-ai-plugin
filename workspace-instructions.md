# simpsonm09-org working agreements
- Work through pull requests. Push a branch to your fork (`origin`) and open the pull request against the organization repository (`upstream`).
- Open pull requests only against repositories owned by `simpsonm09` or `simpsonm09-org`. Never against a third-party upstream.
- An agent-access gate checks shell commands that write to GitHub. Each repository has an access level in the fleet catalog (`repos.json` in `simpsonm09-repo-catalog`).
- A gate denial is final for that command. Do not retry it through another shell, tool, wrapper, or identity. Report the denial and its reason.
- A repository missing from the catalog is denied for writes. The fix is a catalog entry, not a workaround.
- Use `repo-standard` for change gates, the definition of done, and the pull request flow. Use `repo-tasks` for build, test, and verification commands. Use `service-integrations` before reaching a shared service.
- Keep secrets, tokens, and machine-specific paths out of commits, prompts, and logs.
