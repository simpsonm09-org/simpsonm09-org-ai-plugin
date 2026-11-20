# Standalone owned-repository gate

The gate supports a separate `owned-repositories.json` policy for an exact personal repository that has no upstream. The pinned resolver reads this policy from the catalog clone's committed `upstream/main` ref. A local edit, local `main`, missing file, malformed file, or a policy that fails the resolver's strict validation cannot grant access.

An accepted exact target can create a non-default branch and open a pull request whose base and head stay in that same repository. Default-branch, force, delete, and tag pushes, cross-repository pull requests, merges, administration, and unlisted destinations are denied. Branch-only `--base` or `--head` forms omit absent identity fields when sent to the resolver; any partial or explicit null identity remains visible and is denied.

This plugin change adds no catalog record. Adding a repository requires a separately reviewed catalog change. The resolver pin is `92d58ab2b42384931d5bf994f89933fc00978332` and the packaged artifact is refreshed by `scripts/refresh-gate-resolver.mjs`.
