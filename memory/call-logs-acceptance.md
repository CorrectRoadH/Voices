---
format: concord.document/v1
id: call-logs-acceptance
title: 统一调用日志实现与验收
createdAt: 2026-10-23T02:38:01.948Z
kind: memory
memoryKind: note
state: captured
epoch: 0
promotions: []
history: []
---

# 统一调用记录实现验收

2026-10-23 完成 [统一调用记录](../docs/feature/call-logs/README.md)。管理员与个人复用 external_calls 和同一界面，保留 30 天；metadata 不保存正文、密钥或 URL。设计先经独立原生 Codex GPT‑6.1 Sol Review，结论见 call-logs-review。

## 实际验证

使用本轮独立 PostgreSQL（非生产）执行：

- `vp run check`：完整门禁通过，含 Go/PostgreSQL、前端、Worker 静态与常规测试、发布脚本测试、Go vet 和构建。
- `vp run test:go`：补充完成记录写入失败验证后再次通过。覆盖 STT 各操作、账号隔离、派生中断的分页、删除/恢复/晚到结果、到期不复活、生成独立历史、token 缺失/null/错误类型/负数/零。通过 PostgreSQL 连接边界丢弃真实 COMMIT 回执，验证 STT sent 与 AI claim 已提交但客户端错误时不发送或再次领取。
- `vp run test:calls`：真实 Go/PostgreSQL/Chromium 的中文自然语言 E2E 通过，覆盖个人入口、AI 用量、管理员账号与类型/状态筛选、51 条分页、详情、刷新、空结果和 390px 窄屏。测试代理显式使用 gpt-6.1-sol，应用外部服务 fake；未全量重跑其它浏览器场景。
- `concord check --fresh` 与 `concord trace show call-logs --fresh --json` 通过。系统安装 dist 曾暂时缺失，先用源码入口检查，安装恢复后已用正式命令复核。实现前 trace gaps 已执行；关系检查不等于覆盖率证明。

浏览器首轮因“调用成功”同时匹配筛选项与标签失败，改为结果标签精确断言后通过；没有修改业务来绕过该断言。既有 lint 与构建大包警告保留。未发布或部署生产。

本轮 Review pane 已关闭；浏览器、应用循环和测试 schema 均由 fixture 回收，独立测试 PostgreSQL 在交付前停止。无新 worktree/tab 遗留。
