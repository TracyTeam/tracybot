# Traceability via Git

* Status: accepted
* Iteration: 1

## Context

Tracybot has to reliably trace LLM-generated code to its source prompts while integrating with common workflows.

## Decision

Traceability is implemented using hidden Git commits created by OpenCode. When the user creates a commit, the hidden chain is tracked to the user commit via Git notes.

## Rationale

The alternative (file copies) was rejected due to incompatibility with Git workflows, especially merging. The accepted decision is transparent to the user and integrates well with Git.

## Consequences

The tool becomes dependent on Git, requires that users not manually use Git notes, and must handle operations like rebasing, squashing, and amending.
