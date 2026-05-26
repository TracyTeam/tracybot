# Decouple tracing logic from agent and editor integrations

* Status: accepted
* Iteration: 1

## Context

The system must intercept AI prompts, execute prompt tracing logic, and visualize this data in the developer's environment. 
Embedding the core tracking logic directly into the agent plugin or the editor extension would tightly couple the system to those specific tools.

## Decision

Extract the core prompt tracing logic into a stand-alone backend that operates independently of the agent and the editor. 
 
## Rationale

This modularity separates concerns, keeping the agent and editor plugins lightweight as they only need to handle data interception and visualization, respectively. 
This design ensures extensibility, where adding support for new tools requires minimal implementation, as new integrations simply interface with the existing tracing backend.

## Consequences

Introduces additional architectural complexity by requiring a third discrete component implementing the tracing logic, and the related communication between the components.
