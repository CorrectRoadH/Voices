# Your title

This page answers how to call the commands. State observable behavior directly: argv, human-readable output, stdout and stderr, `--json` fields, exit codes, and named errors. Keep implementation in the architecture page.

## Command

Define the command, positional inputs, flags, defaults, and invalid combinations.

## Output

Specify human-readable output and machine-readable output, including their exact success semantics.

## Errors

List each named error, its exit code, and which input it identifies. When another entry point shares the error, define it once here and let that page state only its own mapping.

## Minimal Example

Show the shortest complete invocation and its observable result.
