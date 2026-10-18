# Developing with Concord

Concord drives development by connecting current product contracts, implementation declarations, real test declarations, and engineering memory. Before changing behavior, update or confirm the owning Feature, leaf Use Case, documented CLI page, and any required Design.

## Connect implementation to contracts

Configure sourceRoots in concord.config.ts, or initialize with --source-root src (repeatable).

Run concord --skill code for file, function and statement-region declarations. Use code annotate to generate comments, code locate <path> --line <n> to inspect all containing scopes, and trace show to reverse-query the contract.

Code declarations describe implementation associations, not completion or test coverage.

## Choose the document that owns your intent

- [Feature](feature/README.md): the adopted product contract, even when implementation is still catching up.
- [Roadmap](roadmap/README.md): a settled direction awaiting adoption.
- [Design](design/README.md): goals, constraints, self-contained alternatives, and the reason for a decision.
- [Engineering](engineering/README.md): how this repository is tested and maintained.
- [Research](research/README.md): freeform research topics and supporting materials.
- [Memory](../memory/README.md): problems, decisions, and reusable lessons with their history.
- [Issues](issues/README.md): local observations awaiting investigation.

Write contracts as declarations of intended behavior, constraints, and acceptance. Product workflows and lifecycle rules belong in contracts. Development logs, investigation history, and implementation progress belong in Memory. Observations awaiting investigation belong in Issues.

Templates provide writing prompts, not completed requirements or evidence.
Read docs/constitution.md before creating or revising Feature and Design owners, and record applicable real clause anchors through constitutionRefs.

## Recall and maintain local knowledge

Use `concord memory index --json` and `concord memory recall "query" --json` to discover current memories and read their content. Use `concord issue index --json` and `concord issue recall "query" --json` for observations. These indexes are derived; do not maintain a manual INDEX.md or directly read or edit Memory/Issue owner files.

Create through `memory add` or `issue create`; update author prose with `memory edit` or `issue edit`, supplying the latest digest from recall. Change lifecycle state and relationships only with the corresponding Concord commands. If an operation is missing, report or implement the tool gap instead of editing files around its guards.

Local issues require no external account or connection. GitHub and Linear are optional read adapters; local notes and state remain local. Only an unlinked local draft with no history can be removed with `issue remove` and its current digest. Local removal never deletes a remote issue.

## Scoped concepts and writing

Use `concord concepts index --json` for a derived project glossary. The global catalog is docs/concepts.json; each Feature, Engineering, or other docs subdirectory may own its own concepts.json and concord-writing.json. The containing directory defines local scope.

Keep definitions, stable IDs, preferred names, permitted aliases, and deprecated names in JSON; use Markdown for explanation and examples. Only deprecated names generate terminology bans.

Use concepts and writing show/set commands or the Web workbench to maintain each owner with its current digest. Do not duplicate definitions into a global aggregate or edit managed JSON around these guards.

Writing v2 composes ancestor policy within scope. Check saved inputs with `concord docs check --json`. Migrate writing/v1 only after author review. Never convert permitted aliases into banned names.

## Complete setup

Init installs every category, the documentation entry point, and the complete [template reference set](_template/README.md).
Init supplies missing concepts.md and architecture.md outlines, an empty global concepts.json, and the global writing preset. Existing root documents, catalogs, and policies retain their bytes.

The preset limits sentences to 140 characters and paragraphs to 320. It checks vague wording and unused concepts in Markdown and MDX.

Feature, Roadmap, and each Design candidate require README. Select optional pages with `--pages library,cli,architecture,lifecycle,use-case`, or repeat `--pages`. Omission uses project defaults. `--no-pages` creates README only.

Design decision wrapper pages are always created. Engineering starts with README and expands by topic.

Page add adds optional pages or supporting topics using a single Unicode name, such as migration or 认知与执行. Update the author-owned README links after adding pages. Custom pages remain part of their package, with the same digest checks.

Document IDs and Use Case filenames also accept Unicode letters, combining marks and numbers, with single hyphen separators; spelling is preserved. Names cannot contain path separators, whitespace or traversal components.

## First feature

```
concord feature create login --title "Login"
concord use-case create expired-token --feature login --title "Reject expired tokens"
```

Fill in the generated author prose. Use `concord template list` and `concord template show feature` to inspect bundled templates.

`--body <file>` supplies your own prose; `--body -` reads stdin.

`page show` returns the current digest; `page set --expected-digest` checks it before replacing a page.
Lifecycle metadata remains owned by the corresponding Concord commands.

## Connect a real test

Place `// @use-case docs/feature/login/use-case/expired-token.md` in the test file. `//`, `#`, and `--` are markers. Concord derives the execution reference from the file and marker; no manual ID or attach step is needed.

Then run `concord check`, `concord test list`, and `concord trace show docs/feature/login/README.md`.

Run `concord trace gaps --json` to find contracts and documented CLI pages without explicit code or active test relationships. These are relationship gaps, not coverage results; product-owned inventory is still required to discover undocumented commands.

Use `--regression memory/<problem>.md` when a test protects a recorded Problem.

Source annotations are the only source of these test relations; reverse lists are derived. A marker is the case. Concord does not parse host test syntax. Concord derives the `neref_...` test reference from the file and marker; use `@regression` for a Problem and `@status retired` to retire a generic relation.

Without `@name`, a run covers the marked file and does not claim a native case passed. Repository profile additionally supports `@issue` and file-wide `@test-file`; that parser is separate.

## Configure and run verification

`concord.config.ts` owns testRoots and runner configuration for projects. Unsupported input is rejected without conversion. Defaults scan test/ and tests/ using Node native tests.

For a documentation-only repository, initialize with `concord init --docs-only`: testRoots is empty and no test directories are required.
Add real test roots to the project configuration when tests exist. A successful documentation check does not establish test coverage.

Use `concord doctor` to inspect the configuration and missing test roots without running repository commands.

For another runner, set runner to an object such as:

```
{"kind":"command","argv":["your-runner","{file}"],"sourceFiles":[],"timeoutMs":60000}
```

Replace the executable and arguments with your repository test command. Each placeholder must occupy one complete argument;
supported placeholders are {file}, {name}, and {pattern}. Arguments never run through a shell.

Include additional assertion or runner configuration files in sourceFiles. Concord does not install your dependencies.

Only `concord test run <id>` executes the runner. Check, trace, template, and doctor do not run tests.

Run results are command evidence, not proof that a native case executed or that a feature is covered.

For a Problem fix, capture a normal failing red command, change the product implementation, then capture green.

Keep the test definition and contract unchanged between both runs. Close the Problem using both receipt IDs and an explicit reason.
See `concord memory resolve --help`. Use `concord review render` for local review material.

## Working safely

`--dry-run` previews document mutations. Existing files are never overwritten by init or create.
`--json` emits machine-readable results. An empty repository can pass integrity checks without having tests.

Private evidence is per Git worktree and is not copied by a normal clone; missing historical evidence remains unavailable.
Use `concord recover` for an interrupted publication and `concord cache rebuild` for disposable cache repair.
