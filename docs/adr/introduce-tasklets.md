# Group Plan prompts with each Build prompt

* Status: accepted
* Iteration: 1

## Context

Agentic tools commonly include Plan and Build modes, used for reasoning about changes and making code changes, respectively. A common workflow is to iteratively prompt the agent in Plan mode until satisfactory, then switch to Build mode.

## Decision

Introduce the notion of a Tasklet—on code changes, group Plan mode prompts (if any) together with a Build mode prompt into a Tasklet.

## Rationale

If Tracybot only tracked Build mode prompts, only short approval prompts would be tracked, and the prompts showing user intent would be lost, hindering code explainability.

## Consequences

Additional logic is needed to build and parse Tasklets, introducing processing and storage overheads compared to tracking a single prompt per change.
