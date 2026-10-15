# Trust direct Claude plugin copies

The Claude hook now recognizes a direct plugin copy at `<workspace>/.claude/plugins/<name>` as belonging to that workspace. It continues to derive the workspace from the hook's own real file location; environment variables and the current working directory do not select it. OpenCode junction installs and development checkouts retain their existing trust rules.
