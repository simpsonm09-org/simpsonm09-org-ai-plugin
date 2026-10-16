# Test fixtures

- `parity-golden.json` records the baseline gate outcome for each committed cell (command text, environment, and action), with a fixture token and local git clones. `tests/parity.test.ts` checks the current code against it. The runtime resolver in these tests is the packaged, hash-verified artifact at `runtime/agent-access.mjs`.
- `parity-decisions.json` declares the committed cells the destination-aware gate changes on purpose, with the recorded HEAD action, the new action, and a rationale, for the single-remote clone topology the golden file models.
- `parity-two-remote.json` declares the cells for a real two-remote clone (`origin` = the personal fork, `upstream` = the organization repository) that the single-remote golden topology cannot carry: the gh writes with no `-R` that the destination becomes ambiguous for, and the explicit `-R` variants. `tests/two-remote-parity.test.ts` checks each cell against the golden action for the same command without the ambiguity.
