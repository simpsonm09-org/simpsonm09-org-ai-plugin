---
name: repo-standard
description: Use when a change to any fleet repository needs to land, when asked what "done" means here, or when a check fails. States the gates, the definition of done, and the branch and pull request flow.
---

# The fleet standard

Every repository in `simpsonm09-org` follows one standard. The standard lives in
[`simpsonm09-repo-standard`](https://github.com/simpsonm09-org/simpsonm09-repo-standard).

## The gates

A pull request against `main` must pass all of these. They are enforced by the
`protect-main` ruleset, so a red or missing check blocks the merge.

- `lint / flint` runs Flint over the changed files.
- `aislop / aislop` runs the AI-slop gate.
- `security / trivy` and `security / secrets` scan dependencies and history.
- `standard / standard` checks the repository against the standard.
- `test` runs the repository suite. Name the job `test`.

Commits must be signed. The ruleset enforces `required_signatures`.

## Definition of done

A change is done when the standard check is green, the test check is green with the
changed-line coverage the repository gates, the change is verified on the real artifact,
commits are signed, no secret or machine path is committed, docs and `docs/manifest.json`
match, and anything that ships carries a release note. The full text is in the standard's
[`docs/definition-of-done.md`](https://github.com/simpsonm09-org/simpsonm09-repo-standard/blob/main/docs/definition-of-done.md).

Verification is not "it compiles". Run the feature, call the endpoint, or drive the screen,
and state the command or the observation in the pull request.

## How work lands

- `main` is protected. Work on a branch, open a same-repo pull request on the organization,
  and let the checks run before the merge. Never push directly to `main`.
- The pin to the standard is a commit SHA in `.github/workflows/ci.yml`. The `pin-update`
  workflow reports when it falls behind.
- The task runner is `just`. Run `just lint`, `just test`, and `just verify` before pushing.

## Where the standard lives

- `repo-standard` owns the checks, the reusable workflows, the rulesets, and the docs.
- `repo-catalog` owns the roster, the tiers, and the [roadmap](https://github.com/simpsonm09-org/simpsonm09-repo-catalog/blob/main/docs/roadmap.md).
- `repo-template` is the starting point for a new repository.
