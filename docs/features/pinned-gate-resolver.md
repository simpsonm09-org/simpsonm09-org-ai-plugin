# Pinned gate resolver

The plugin bundles the reviewed access resolver from `simpsonm09-org/simpsonm09-repo-standard`. Its pin records the source commit and path, SHA-256, and API version. The loader checks the bundle's hash and required API before importing it.

The resolver reads access levels from committed catalog refs. If the bundle or committed catalog is unavailable, the gate denies writes. The GitHub token broker remains in the repo-standard clone.
