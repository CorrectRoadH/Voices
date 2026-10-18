---
format: concord.constitution/v1
status: active
ratifiedAt: 2026-10-18
amendedAt: 2026-10-18
amendments:
  - date: 2026-10-18
    reason: 落实用户明确的产品与技术约束
    sources:
      - 用户需求讨论 2026-10-18
    impact: 约束需求、架构与后续实现
  - date: 2026-10-18
    reason: 用户明确要求仅支持 PostgreSQL
    sources:
      - 用户需求修订 2026-10-18
    impact: 删除双数据库兼容约束，采用 PostgreSQL 原生模型与任务领取
  - date: 2026-10-18
    reason: 用户要求项目采用 stateless 应用架构
    sources:
      - 用户需求修订 2026-10-18
    impact: 音频持久化迁入 PostgreSQL，实例可替换且不依赖应用数据卷
  - date: 2026-10-18
    reason: 用户指定 shadcn/ui + Base UI
    sources:
      - 用户需求修订 2026-10-18
    impact: 前端组件与交互实现使用 Base UI 版 shadcn/ui
---

# Voices 项目原则

<a id="c-001"></a>
## C-001 自托管与用户控制

录音和转写结果由用户部署的实例保存。外部 STT 调用须由用户配置，凭据不得下发浏览器。

<a id="c-002"></a>
## C-002 技术栈

前端使用 Vite+、React、shadcn/ui + Base UI，后台使用 Go；数据库仅支持 PostgreSQL，优先使用其原生能力。

<a id="c-003"></a>
## C-003 产品契约

使用 Concord 管理需求、用例、设计与验收关系。文档检查不等于软件功能已实现或通过验收。

<a id="c-004"></a>
## C-004 应用无状态

应用实例不保存必须跨重启保留的本地状态。业务数据、音频、会话和后台任务存于 PostgreSQL；临时文件可随实例销毁。
