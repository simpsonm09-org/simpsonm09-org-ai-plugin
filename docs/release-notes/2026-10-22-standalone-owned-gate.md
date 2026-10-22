# Resolve exact standalone repositories

The gate now consumes the repo-standard resolver's committed exact owned-repository policy through the same destination decision used by the plugin and hook adapters. The policy is read from committed `upstream/main` only and is limited to non-default branch pushes and same-repository pull requests. Missing or invalid policy leaves the target denied.

The packaged resolver pin advances to API version 3 at `c0829a2f83636f9374fb079bdd3e2d34a56f5c42`. No production catalog grant or gate installation is included.
