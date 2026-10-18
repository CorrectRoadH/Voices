---
format: concord.document/v1
id: stateless-and-sentence-links
title: 无状态存储、逐句引用与前端技能
createdAt: 2026-10-18T01:29:34.858Z
kind: memory
memoryKind: note
state: captured
epoch: 0
promotions: []
history: []
---

# 无状态存储、逐句引用与前端技能

2026-10-18 用户要求应用 stateless，并指定 shadcn/ui + Base UI、逐句 Markdown 深链接和安装官方 shadcn skill。

主 agent 更新 [架构](../docs/architecture.md)，新增无状态部署与逐句链接 Feature/Use Case，比较分块 bytea 和 Large Objects。
通过 Herdr 启动原生 Codex / gpt-6.1-sol high 独立审查，收敛快照回退与人工查询观察两项问题，限定复审通过。
主 agent 核对范围、检查文档后关闭本轮 review pane，无残留资源。

使用 skill-installer 官方辅助脚本，从 shadcn-ui/ui 的 skills/shadcn 安装到用户 Codex skills 目录。
安装输出成功，21 个文件，SKILL.md 所引本地参考文件均存在。此操作仅安装开发 skill，没有初始化前端或安装应用组件。

Concord check 与 trace check 通过；无产品代码与运行时测试。存储裁决见 [Decision](../docs/design/stateless-media/DECISION.md)。
