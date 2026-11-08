# Your title

## User Goal

State who wants what and why, in the user's language. One goal per Use Case.

## Starting State

List what must already be true: configuration, existing documents, data.

## Complete Path

Write one numbered item per user action. Show the exact command or call and its output. Copy real output once the feature runs; before that, mark it as expected output. End the first paragraph of each item with a stable step ID such as `{#run-red}` so tests and code can point at that step.

For interactive explanations, an optional `p5` fence can show the process. State the initial conditions, controls and expected observation in prose. Readers explicitly run sketches; animation does not replace acceptance evidence. Keep Mermaid for static flows and read `concord --skill view` for p5 authoring and project library configuration.

## Result

Describe the observable end state. List every failure the user can see in a table of error code and trigger, with one real error output.

## Contract Sources

Link only to existing pages that own the CLI, API, or architecture rules used by this path. Do not redefine those rules here. Implementation belongs in the architecture page, not here.
