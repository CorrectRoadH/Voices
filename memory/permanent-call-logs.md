---
format: concord.document/v1
id: permanent-call-logs
title: 调用日志改为永久保存
createdAt: 2026-10-23T02:44:51.202Z
kind: memory
memoryKind: decision
state: current
epoch: 0
promotions: []
history: []
---

# 调用日志永久保存

2026-10-23 用户要求发布 v0.0.5，并明确调用日志永久保存，取代此前 30 天保留方案。当前契约见 [调用日志](../docs/feature/call-logs/README.md)。

移除 external_calls 的自动删除与查询时间下限，保留中断标记和原有授权边界。API retention_days 为 null，表示无期限；删除录音不删除调用元数据。新增十年前记录经过后台维护后仍能查询的回归断言。数据库结构无需迁移。

隔离 PostgreSQL 的 vp run check 与 Concord check 已通过。发布流程发现 GitHub Actions 未配置 E2E_MODEL_API_KEY；未擅自转交本机密钥或绕过浏览器门禁，已请求用户明确授权配置测试凭据。发布成功与否以实际 Release 流水线和产物为准。
