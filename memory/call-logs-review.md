---
format: concord.document/v1
id: call-logs-review
title: 统一调用记录的独立设计审查
createdAt: 2026-10-23T02:33:59.725Z
kind: memory
memoryKind: decision
state: current
epoch: 0
promotions: []
history: []
---

# 统一调用记录设计审查

主 agent 先形成 [具体方案](../docs/feature/call-logs/architecture.md)，独立 Review 使用 Herdr 原生 Codex / GPT‑6.1 Sol high，2026-10-23 收敛后无阻塞项。审查只读，核心模型及实现由主 agent 负责。

审查要求保留四项边界：STT sent 与 AI claim 的事务提交回执不明时不发送；完成记录只按调用 ID 更新未完成行，不依赖仍存活的业务对象、不重建已清理行；SDK 用量按字段存在性读取，零与未知分开，内容验证失败保留用量；派生 interrupted 在筛选与分页前计算。

主 agent 接受上述结论，将其纳入架构约束与针对性验证。AssemblyAI 不支持独立删除上传文件时的本地尝试标记 request_started=false，不能拿日志行数直接当 HTTP 请求数或账单。

Review pane 已验收回收。设计审查通过不代表实现或浏览器验收通过，实际验证由本次提交的测试与运行结果交接。
