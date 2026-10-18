---
format: concord.document/v1
id: builtin-people-and-fixed-import
title: 内置人物、录音人物摘要与固定导入流程
createdAt: 2026-10-18T03:50:54.714Z
kind: memory
memoryKind: note
state: captured
epoch: 0
promotions: []
history: []
---

已实现 migration 004：每用户内置背景声、音乐、系统提示音，沿用 owner/person_id 关联，禁止修改归档。people 默认排除内置，include_builtin=true 获取全部。segments hide_builtin=true 在分页前过滤有效人物，anchor 按过滤后前序条数计算。网页默认隐藏，开关可显示，句子深链接显示原文，导出保留。Recording.people 聚合当前激活版本实际片段普通人物并按 UUID 去重。
网页固定自动转写、区分说话人，删除相关开关、默认偏好启用开关及普通发送确认；不改已接受任务快照，API 原有可选导入字段保留，受理不明重复提交确认保留。
验证：scripts/test.sh 通过（Go tests/vet、21 前端单测、构建）；真实 Go/PostgreSQL 浏览器 2 测试通过，含背景声隐藏恢复和列表摘要；13 E2E 中 11 原先通过，2 上传测试补齐模拟服务商后定向通过；concord check 通过。未提交或推送，无新 pane/tab/worktree。
单独 STT 日志费用需求仍待独立 review（Herdr pane_not_found，未获本任务豁免），尚未实现。
