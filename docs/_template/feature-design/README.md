# Your title

Before writing, read `docs/constitution.md` and record every applicable real clause anchor in this Feature's `constitutionRefs` metadata.

Declare intended behavior, constraints, and acceptance. Keep development logs, investigation history, and implementation progress in Concord Memory; product workflows belong in the contract.

## Problem

Describe the user problem and why the product needs a current contract for it.

## Core Mental Model

Define the concepts users must understand and identify who owns each declaration.
Reference shared JSON concepts, or define local terms in this directory's
`concepts.json` through Concord tools. Use prose here to explain their relationships.

Use Mermaid for structural diagrams and optional `p5` Markdown fences for animation or interaction. Keep the conclusion readable without running a sketch. Read `concord --skill view` for examples; declare extension libraries in project configuration, never in Markdown.

## Scope

State what the feature includes and excludes.

## Entry Points

- [Library](library.md)
- [CLI](cli.md)
- [Architecture](architecture.md)
- [Lifecycle](lifecycle.md)
- [Use Cases](use-case/README.md)
