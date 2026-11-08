# Your title

Describe how this feature is implemented. Behavior belongs in the README, Use Case, cli, library, api, format, ui, and performance pages; refactors that keep behavior change only this page. When the internal storage needs its own page, write it in `data-model.md` and link it here.

## Modules and Ownership

Name each module, its responsibility, and which owner creates and destroys each entity.

## Data Flow

Trace input to output through each responsible module and name every intermediate product that crosses an ownership boundary.

Use Mermaid for relationships and flows. When motion or adjustable parameters explain the model better, add a `p5` fence and a prose explanation. External sketch and CSS paths are relative to this Markdown page; extension libraries belong in project `p5.libraries`. See `concord --skill view` for complete examples.

## Invariants

List the properties every implementation must preserve.

## Resource Lifecycle

When the feature holds resources or state, describe how each owner acquires and validates them. Then describe how it runs, reuses and revalidates them. Describe cleanup after normal and interrupted runs. State what invalidates reuse and the observable result of cleanup failure.

## Failure Stages

Assign each failure to its stage and owner: acquisition, execution, cancellation or cleanup. Link the observable error to the behavior page that defines it, and do not let one failure hide another.

## Key Choices and Dependencies

Record the choices this implementation depends on, including third-party libraries and internal inter-process communication.
