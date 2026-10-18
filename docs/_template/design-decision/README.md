# Your title

Before comparing plans, read `docs/constitution.md` and record every applicable real clause anchor in this Design's `constitutionRefs` metadata.

## Problem

Describe the decision to make and why comparing alternatives is necessary.

## Core Mental Model

Define the concepts and evaluation criteria shared by every candidate.

## Scope and Tradeoffs

State the decision's boundaries and the tradeoffs the comparison must address.

## Entry Points

- [Goals](GOALS.md): requirements and comparison criteria.
- [Limits](LIMITS.md): constraints shared by every candidate.
- [Cases](CASES.md): neutral scenarios for the comparison.
- [Decision](DECISION.md): explanatory evidence.
Each candidate in plans/ is a self-contained feature design package.
The decision is recorded only by `concord design decide`; writing prose does not select a candidate.

Goals and Limits use stable G/L-numbered H2 entries. Every candidate README must respond to all entries in its Goals and Limits tables, including failures and pending evidence.

Run `concord design check <id>` before deciding. `concord design format <id>` only normalizes supported layout; it never supplies a choice or evidence.

Record the exact selected slug and link in DECISION, explain accepted Goal gaps, then decide. All selected-plan Limits must be satisfied.
