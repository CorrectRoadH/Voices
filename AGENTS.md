<!-- BEGIN CONCORD AGENT INSTRUCTIONS -->
## Concord

This repository uses Concord-driven development. Product contracts, executable test relationships, and engineering memory stay in repository-owned sources.

Before planning, implementing, or reviewing governed work:

- Run `concord --skill` to read the task router from the installed Concord version.
- Run `concord --skill <topic>` for the relevant workflow, where topics include `init`, `document`, `code`, `test`, `memory`, `trace`, `recovery`, `view`, `feedback`.
- Use `concord --skill all` only when the complete offline guide is needed.
- Before changing behavior, read or update the owning Feature, leaf Use Case, documented CLI page, and any required Design. Then run `concord trace gaps --json` to inspect missing explicit code/test relationships before implementation.
- Write contracts as declarations of intended behavior, constraints, and acceptance. Keep development logs, investigation history, and implementation progress in Memory; product workflows remain valid contract content.
- Directly edit files under `docs/` and `memory/`, including relations. Use `concord memory search` and `concord issue search` for search. Commands run required steps such as fix verification; run `concord check` before delivery. Do not maintain a manual INDEX.
- For remote Issue writes, run remote preview, obtain explicit user agreement to its authorization string (or its action, target, and payload), then remote apply with `--authorize`; never infer authorization from preview success, tool availability, or permissive access.
- Local issues work without GitHub, Linear, credentials, or connections. Use `concord new issue` for local observations; local operations never authorize remote mutations.
- Directly edit directory-scoped `concepts.md` and `writing.md`; `concord check` validates them. Keep each concept's term, definition and explanation together; only deprecated names become terminology bans.

Follow the returned instructions and the repository's current `docs/taste.md`. A gap result means an explicit Concord relationship is absent; it is not code coverage, and undocumented CLI commands require the product's own inventory. Do not infer completion or test coverage from document structure or command receipts alone.
<!-- END CONCORD AGENT INSTRUCTIONS -->

## UI design

- Before changing UI, read `web/DESIGN.md` and the owning Concord Feature / Use Case. Keep UI guidance and implemented behavior aligned.

## JavaScript / TypeScript toolchain

- Use Vite+ 1.3.0 (`vp`) for JS/TS commands: `vp install`, `vp run <script>`, `vp exec <tool>`, and `vp exec node <file>`. pnpm remains the underlying package manager.
- Root, `web`, and `update-worker` remain separate installation roots; install with `vp -C web install --frozen-lockfile` and `vp -C update-worker install --frozen-lockfile`.
- From the repository root, run `vp run check` for the full gate; it requires an isolated `TEST_DATABASE_URL`. `vp check` is only the built-in static checker, not the full project gate.
- Use `vp run test:e2e` for real Go/PostgreSQL/browser acceptance and `vp run test:worker:runtime` for workerd. Keep these uncached; they depend on runtime state.
- Keep framework builds and Go tests behind their existing scripts. Do not replace them with bare `vp build` or `vp test`.
