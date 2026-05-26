# Determine code change significance with BLEU

* Status: accepted
* Iteration: 2
* Date: 20-04-2026

## Context

Simple code changes such as formatting or renaming should not shift attribution.

## Decision

Use BLEU similarity score on Git hunks to approximate change significance. Consider changes with similarity above a certain threshold as insignificant, and do not shift attribution for those changes.

## Rationale

Several alternatives to measure change similarity were examined. Advanced similarity scores such as CodeBLEU are not suitable for this use-case, given that syntax scanning cannot be applied to small hunks. CrystalBLEU was rejected as an alternative due to needing language-specific corpora, and only showing insignificant improvements over BLEU in the context of Git hunks according to internal testing.

## Consequences

Changes with high similarity do not shift attribution. A similarity threshold must be established below which changes are considered significant.
