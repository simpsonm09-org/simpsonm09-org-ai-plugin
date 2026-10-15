# Test fixtures

- `parity-golden.json` records the baseline gate outcome for each committed cell (command text, environment, and action), with a fixture token and local git clones. `tests/parity.test.ts` checks the current code against it. The runtime resolver in these tests is the packaged, hash-verified artifact at `runtime/agent-access.mjs`.
