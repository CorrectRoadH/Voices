# Your title

An Issue is a problem that still needs handling. When it is handled, `concord issue close` runs the needed steps and deletes this file; Git keeps the history.

## Observation

Describe the local, reproducible observation without assigning an unverified cause.

## Expected Behavior

For a defect, link the Spec page or anchor whose behavior is not met and state the expected observable result.

## Reproduction

List the smallest repeatable steps, inputs, and resulting output.

## Investigation

Record evidence and remaining hypotheses. Put reusable findings in Memory and link them from the `relations` frontmatter with the `investigation` or `root-cause` role.

To close a defect as fixed, first commit a failing regression test marked `@issue docs/issues/<id>.md`, then commit the fix and run `concord issue close <id> --fixed`. The command verifies both commits, deletes the Issue, and prints a conclusion for the commit message.
