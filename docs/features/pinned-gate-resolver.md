# Pinned gate resolver

The plugin bundles the reviewed access resolver from `simpsonm09-org/simpsonm09-repo-standard`. Its pin records the source commit and path, SHA-256, and API version. The loader checks the bundle's hash and required API before importing it. API version `2` requires the destination surface — `loadCommittedOwnedForks`, `resolveDestination`, and `decideTarget` — in addition to `loadCommittedCatalog`, `resolveLevel`, and `decide`; a bundle without them loads as a null API, so every write is denied.

The resolver reads access levels from the roster ref (`upstream/main` or `main`) and the owned-fork policy from `upstream/main` only, in committed catalog refs. If the bundle or committed catalog is unavailable, the gate denies writes. The GitHub token broker remains in the repo-standard clone.
