# 单进程持久化任务

采用一个 Go 进程，数据库存任务，本地数据卷存媒体。完整方案见 [架构](../../../../architecture.md)。

## Goals

| Goal | Status | Mechanism | Evidence |
| --- | --- | --- | --- |
| [G1](../../GOALS.md#g1-self-hosting) | satisfied | 应用容器与 PostgreSQL，媒体保存在本地卷 | 部署组成与备份边界 |
| [G2](../../GOALS.md#g2-durable-work) | satisfied | 数据库记录任务与不确定提交 | 故障案例与恢复契约 |
| [G3](../../GOALS.md#g3-complete-product) | satisfied | 可选结果字段和用户校正 | 产品契约 |

## Limits

| Limit | Status | Mechanism | Evidence |
| --- | --- | --- | --- |
| [L1](../../LIMITS.md#l1-stack) | satisfied | Go 与 React，PostgreSQL 原生类型与行锁 | 技术栈约束 |
| [L2](../../LIMITS.md#l2-ownership) | satisfied | 不可变原件、独立版本、删除协调 | 资源生命周期 |
| [L3](../../LIMITS.md#l3-credentials) | satisfied | 服务端凭据和统一鉴权 | 信任边界 |

优势是个人部署组件少；代价是初版只支持单实例，不能水平扩容。satisfied 表示设计满足要求，不代表实现验证通过。
