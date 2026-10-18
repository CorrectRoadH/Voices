---
format: concord.document/v1
id: stateless-media
title: 无状态应用与 PostgreSQL 音频存储
createdAt: 2026-10-18T01:18:39.244Z
kind: design
alternatives:
  - chunked
  - large-object
decision:
  selected: chunked
  reason: PostgreSQL分块媒体实现无持久应用盘，发布/租约/恢复边界经独立审查收敛
  at: 2026-10-18T01:29:33.822Z
  targets:
    - docs/feature/stateless-deployment/README.md
---

# 无状态应用与 PostgreSQL 音频存储

应用无状态指实例没有持久数据盘；PostgreSQL 仍负责持久状态。目标是更换实例不丢录音，并统一备份边界。

比较分块 bytea 与 PostgreSQL Large Objects。单个 bytea 字段存在大小限制，不适合既有 2 GiB 文件上限，因此不作为完整文件容器。

本裁决更新 [初始架构](../foundation/README.md) 的媒体持久化与实例边界，保留 Go 应用内后台任务及现有远端操作恢复协议。

- [目标](GOALS.md) · [限制](LIMITS.md) · [案例](CASES.md)
- [分块 bytea](plans/chunked/README.md) · [Large Objects](plans/large-object/README.md)
- [完整方案](../../architecture.md) · [裁决](DECISION.md)
