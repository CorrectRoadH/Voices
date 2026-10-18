# Your title

## Owners

List each owner's inputs, runtime obligations, and boundaries.

## Create

Describe resource acquisition in order, including validation and readiness before use.

## Run

Describe the complete execution sequence and which owner controls each transition.

Use Mermaid to show state transitions, or an optional `p5` fence to demonstrate timing and interaction. Explain the same transitions in prose and keep sketch dependencies in project `p5.libraries`; authoring examples are available through `concord --skill view`.

## Reuse

State what can be reused, what must be reset or revalidated, and what invalidates reuse.

## Cleanup

Describe normal and interrupted cleanup, ordering, idempotency, and the observable result of cleanup failure.

## Failure Ownership

Assign acquisition, execution, cancellation, and cleanup failures to named owners without allowing one failure to hide another.
