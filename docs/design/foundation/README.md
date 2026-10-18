---
format: concord.document/v1
id: foundation
title: 自托管录音管理架构
createdAt: 2026-10-18T00:57:30.987Z
kind: design
alternatives:
  - embedded
  - distributed
decision:
  selected: embedded
  reason: 单Go进程与PostgreSQL满足个人自托管；持久化模型和资源恢复规则经独立审查收敛
  at: 2026-10-18T01:11:23.661Z
  targets:
    - docs/feature/recording-library/README.md
---

# 自托管录音管理架构

此为初始裁决。媒体持久化与实例边界已由 [无状态存储设计](../stateless-media/README.md) 更新；当前实现以 [架构](../../architecture.md) 为准。

比较单进程持久化任务与独立队列服务。首次确定数据模型、跨模块契约及音频/远端资源归属，须经独立原生 Codex Review 后裁决。

- [目标](GOALS.md)
- [限制](LIMITS.md)
- [案例](CASES.md)
- [单进程方案](plans/embedded/README.md)
- [分布式方案](plans/distributed/README.md)
- [完整架构与数据模型](../../architecture.md)
- [裁决](DECISION.md)
