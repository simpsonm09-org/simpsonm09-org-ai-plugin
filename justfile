# Cross-platform task runner for humans and agents. `just --list` shows every
# recipe. Keep each recipe a thin call to a portable tool or a script under
# scripts/. See https://github.com/simpsonm09-org/simpsonm09-repo-standard/blob/main/docs/task-runner.md
set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

# List the recipes.
default:
    @just --list

# Install the pinned tools.
install:
    mise install

# Run every linter over the tracked files, plus the .mjs checks flint's patterns miss.
lint:
    mise exec -- flint run --full
    mise exec -- node scripts/check-mjs.mjs

# Fix what the linters can fix.
lint-fix:
    mise exec -- flint run --fix

# Run the AI-slop gate.
aislop:
    npx --yes aislop@0.16.1 ci

# Run the test suite. `mise run test` holds the repository test command.
test:
    mise run test

# Run the tests and write an lcov report to coverage/lcov.info.
coverage:
    npm ci
    mise run coverage

# Lint and test.
verify: lint test

# Enforce the complexity, lint, and format rules on the .mjs files flint's patterns do not
# reach. The shared lint workflow runs this recipe, so a defect in a runtime module fails CI.
complexity:
    mise exec -- node scripts/check-mjs.mjs

# Check the bundled resolver against the reviewed source object in the standard clone.
check-gate-resolver:
    node scripts/refresh-gate-resolver.mjs --check

# Refresh the bundled resolver from the reviewed source object. This never fetches.
refresh-gate-resolver:
    node scripts/refresh-gate-resolver.mjs


# Prune remote-tracking refs and delete local branches merged into main.
prune:
    node scripts/prune.mjs
