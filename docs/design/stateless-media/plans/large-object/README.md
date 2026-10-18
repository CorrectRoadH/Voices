# PostgreSQL Large Objects

每个媒体使用 PostgreSQL Large Object，以 OID 关联业务记录。需额外登记未发布 OID，并在删除时 unlink；流式 API 的描述符受事务约束。

## Goals

| Goal | Status | Mechanism | Evidence |
| --- | --- | --- | --- |
| [G1](../../GOALS.md#g1-replace-instances) | satisfied | PostgreSQL 共享数据、会话与租约 | 无应用数据卷 |
| [G2](../../GOALS.md#g2-unified-persistence) | satisfied | 数据库统一备份 | PostgreSQL 持久化边界 |
| [G3](../../GOALS.md#g3-bounded-streaming) | partial | 流式描述符依赖事务；若拆为多次读取，需反复开启对象和偏移定位 | 读取事务与传输生命周期 |

## Limits

| Limit | Status | Mechanism | Evidence |
| --- | --- | --- | --- |
| [L1](../../LIMITS.md#l1-postgresql) | satisfied | Go pgx 与 PostgreSQL | 用户技术约束 |
| [L2](../../LIMITS.md#l2-publication) | satisfied | 完整对象与引用原子发布 | 应用层发布协议 |
| [L3](../../LIMITS.md#l3-reclamation) | satisfied | 读写租约、引用核对和回收任务 | 生命周期设计 |

Large Object 可高效随机读取大对象，但 OID 生命周期需要显式管理；短事务分段访问也需要应用层读写协议，未带来足够简化。

satisfied 表示设计满足要求，不代表实现已验证。
