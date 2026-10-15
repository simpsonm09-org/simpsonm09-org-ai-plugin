# Conservative GitHub write detection

Codex now treats recognizable `gh` and `git push` text anywhere in a command as evidence of a GitHub write. This includes quoted payloads, wrappers, and substitutions, so source files containing command examples can be denied. Detection is conservative text matching; it does not parse shell syntax, evaluate variables, or provide a universal security boundary. Variable-built executable names remain unsupported. Existing resolver behavior and Claude/OpenCode runtime guards remain in place.
