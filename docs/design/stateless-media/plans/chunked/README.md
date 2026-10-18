# 分块 bytea

使用 blobs 清单与 blob_chunks 表，每块 1 MiB。短事务写块，最终发布事务绑定业务引用；读租约保护分段读取，后台回收过期 staging。

## Goals

| Goal | Status | Mechanism | Evidence |
| --- | --- | --- | --- |
| [G1](../../GOALS.md#g1-replace-instances) | satisfied | PostgreSQL 共享数据、会话与租约 | 无应用数据卷 |
| [G2](../../GOALS.md#g2-unified-persistence) | satisfied | 数据库统一备份 | PostgreSQL 持久化边界 |
| [G3](../../GOALS.md#g3-bounded-streaming) | satisfied | 短事务读写块并在事务外传输；清单限制大小与可见性 | 读取事务与传输生命周期 |

## Limits

| Limit | Status | Mechanism | Evidence |
| --- | --- | --- | --- |
| [L1](../../LIMITS.md#l1-postgresql) | satisfied | Go pgx 与 PostgreSQL | 用户技术约束 |
| [L2](../../LIMITS.md#l2-publication) | satisfied | 完整对象与引用原子发布 | 应用层发布协议 |
| [L3](../../LIMITS.md#l3-reclamation) | satisfied | 读写租约、引用核对和回收任务 | 生命周期设计 |

完整结构、命名和生命周期见 [架构](../../../../architecture.md)。代价是块表与租约需要实现和验收。

satisfied 表示设计满足要求，不代表实现已验证。
