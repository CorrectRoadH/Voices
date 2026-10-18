# 独立队列与 worker

API 与 worker 分进程，Redis 管调度，数据库保留任务真源；媒体通过共享存储访问。业务数据模型、适配契约与安全要求同单进程方案。

## Goals

| Goal | Status | Mechanism | Evidence |
| --- | --- | --- | --- |
| [G1](../../GOALS.md#g1-self-hosting) | satisfied | 额外部署队列、worker 与共享媒体卷 | 部署组成与备份边界 |
| [G2](../../GOALS.md#g2-durable-work) | satisfied | 数据库记录任务与不确定提交 | 故障案例与恢复契约 |
| [G3](../../GOALS.md#g3-complete-product) | satisfied | 可选结果字段和用户校正 | 产品契约 |

## Limits

| Limit | Status | Mechanism | Evidence |
| --- | --- | --- | --- |
| [L1](../../LIMITS.md#l1-stack) | satisfied | Go 与 React，PostgreSQL 原生类型与行锁 | 技术栈约束 |
| [L2](../../LIMITS.md#l2-ownership) | satisfied | 不可变原件、独立版本、删除协调 | 资源生命周期 |
| [L3](../../LIMITS.md#l3-credentials) | satisfied | 服务端凭据和统一鉴权 | 信任边界 |

可独立扩展处理吞吐，但增加双系统协调、共享卷与备份复杂度。个人单实例目前无需求收益，拒绝作为初版方案。satisfied 表示设计满足要求，不代表实现验证通过。
