# Non-obstructive workflow

* Status: accepted
* Iteration: 1

## Context

Tracybot should not interfere with existing workflows.

## Decision

Use Git hooks (pre-commit, post-commit, and post-rewrite) to automatically update the tracking state in response to repository events.

## Rationale

Commit hooks ensure robust tracking. The post-commit hook attaches a note linking the commit to the hidden chain, and the post-rewrite hook merges notes to preserve history during rebases or squashes. This minimizes user friction without requiring aliases or wrappers.

## Consequences

Initialization must preserve pre-existing user-defined hooks to avoid disruption.
