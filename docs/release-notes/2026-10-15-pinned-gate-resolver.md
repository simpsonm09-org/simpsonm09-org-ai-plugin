# Pin the access resolver in the plugin package

The OpenCode and hook runtimes now use the reviewed resolver bundled with this plugin. The loader checks its SHA-256 and required API before import. It reads access levels from committed catalog refs and denies writes when the bundle or committed catalog is unavailable.

The GitHub token broker still loads from the repo-standard clone. Install the updated plugin and restart OpenCode or start a new Claude Code session to load the new resolver.
