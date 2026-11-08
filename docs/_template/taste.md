# Your title taste

The taste is the judgment the project applies when reviewing Spec and code. It holds no status: when this file exists, its entries apply. Git keeps its history.

Add a general section and one H2 entry per judgment. Each entry's label number matches its ID and is followed by the problem it solves and a good/bad contrast:

```markdown
## General {#general}

1. A taste entry is a standard of judgment, not a rule checked line by line. {#general-use}

## T-1 Readable beats complete {#t-1}

A Spec nobody can read is never reviewed, so nobody maintains it.

- Good: a Use Case a new maintainer can follow step by step.
- Bad: a page of constraints with no example.
```

- IDs are unique, never renamed and never reused; a new entry takes an unused number.
- Pages under `docs/` that rely on an entry link it next to the sentence, for example `[T-1](../taste.md#t-1)`.
