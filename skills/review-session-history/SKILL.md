---
name: review-session-history
description: Use when asked to review past agent sessions for recurring corrections or failures, to find what an agent keeps getting wrong, or to turn a session review into skill edits. Mines stored Claude Code or OpenCode sessions, clusters the recurring themes, ranks each by frequency and impact, and routes it to a named skill edit with its evidence.
---

# Review session history

Stored sessions are the record of what an agent got wrong and what the operator kept correcting. This skill turns that record into a small set of skill edits. It harvests, clusters, ranks, and routes. It adds no skill of its own; each theme becomes an edit to the skill that already owns the behavior.

## Harvest

Read the sessions before you change anything. Harvest before purge, and never delete evidence a change depends on. Read only; do not write to a session store.

Find the store for the harness that ran the sessions. Both can be present on one machine.

- **Claude Code.** Each session is a JSONL transcript, one JSON object per line, in `~/.claude/projects/<project-slug>/`. The slug is the project's working directory with `:`, `\`, and `/` replaced by `-`, so `D:\dev\example` becomes `D--dev-example`. List the directory to find the session files, then read the lines you need. A line number is the pointer to the message that shows a finding.
- **OpenCode.** `opencode session list` lists the top-level sessions of the current project, newest first. Add `--format json` for a machine-readable list and `-n <count>` to limit it. `opencode session export <session-id>` prints one session as JSON. Add `--sanitize` when the export will be quoted, since it redacts transcript and file data. The message in the export is the pointer.

Transcripts can hold secrets, file contents, and personal data. Quote the smallest span that proves the finding, and keep the rest out of the pull request.

- Record each finding with its session id and a pointer to the message, so a reviewer can reopen the evidence.

## Cluster and rank

Group findings that share a cause into a theme. A theme is one recurring correction or failure, not one incident.

Rank each theme by frequency and impact. Frequency is how often the operator made the correction. Impact is what the mistake cost, such as a wrong push, a lost change, or a rerun.

Drop a theme below the bar instead of padding the list. A single correction with no repeat is a note, not a theme.

## Route

Each theme names one skill and one edit. Prefer an edit to a skill that already owns the area over a new skill, and never duplicate a vendored pstack skill. Name the skill, the rule to add or change, and the finding that motivates it.

Write the edit tight. One theme, one rule. Cite the evidence in the pull request so a reviewer can check the claim.

## Cull

Delete a session only when the operator asks. A cull is irreversible and destroys the evidence a finding depends on, so harvest and record the finding first.

- Claude Code: delete the session's transcript file.
- OpenCode: `opencode session delete <session-id>`, which also deletes the session's child sessions.
