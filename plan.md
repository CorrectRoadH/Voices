# Voices 实现计划

方案：[架构](docs/architecture.md)、[无状态裁决](docs/design/stateless-media/DECISION.md)、[具体接口](docs/api/implementation-contract.md)。两次独立设计复审已通过。

- [x] Go 入口、PostgreSQL 迁移、鉴权、配置和部署
- [x] 分块音频导入、播放、清理与任务租约
- [x] Soniox / AssemblyAI 适配与持久转写流程
- [x] 版本、片段、人物、深链接和导出 API
- [x] Vite+ React shadcn Base UI 前端
- [x] 真实 PostgreSQL、HTTP、浏览器和故障验证
- [x] Concord 关系、运行说明及资源回收

主 agent 负责核心后端与集成；前端和服务商适配器按明确接口独立分派，默认 GPT-6.1 Sol。无提交、push 或部署授权。

验收记录通过 Concord Memory 保存为 `implementation-acceptance`。真实付费转写未调用；运行步骤见 [README](README.md)。

本轮创建的 worker pane/tab、测试容器和 PostgreSQL 进程均已回收，无 worktree 残留。

## 独立账号系统

方案：[独立账号与首位管理员](docs/research/account-isolation/README.md)。用户确认每账号独立，首个注册用户为管理员。

- [x] 调查现有共享密码和全局数据模型，形成具体方案
- [x] 用户本次明确豁免独立审查，由主 agent 实现并验证；Herdr 父 pane 已失效，无 worker 资源
- [x] 首版用户名登录、默认开放注册、共用实例服务商额度，管理员可关闭注册
- [x] 更新契约，实现账号、隔离与界面，并完成真实数据库和浏览器验收
- [x] 按用户要求清空本地开发库，验证首次注册入口，未创建测试账号
