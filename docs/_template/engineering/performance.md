# Your title

This page owns the performance budgets of this feature. The measurement method belongs to the project's performance engineering pages; README and Use Case pages link here instead of repeating numbers. Resource safety limits, such as output size caps, belong in the behavior or architecture page that enforces them.

State the reference consumer, reference environment, and load assumptions needed to understand each threshold.

## Budgets

Add a `## 性能预算` heading with one table: the first column lists scenario IDs `<feature-id>/<name>` in inline code, the middle column says what is measured, and the last column is `<integer>ms`, judged by the warm p50. Use a `## 刷新上限` heading with the same columns for limits judged by the maximum sample. Every scenario ID must have a scenario in `bench/<feature-id>.bench.ts`.
