---
format: concord.document/v1
id: administration-insights-acceptance
title: 站点管理与 LLM 摘要验收
createdAt: 2026-10-18T14:34:06.280Z
kind: memory
memoryKind: note
state: captured
epoch: 0
promotions: []
history: []
---

# 站点管理与 LLM 摘要验收

2026-10-18，用户授权对比 OpenToggl 并实现 Voices 管理缺口，随后授权接入 Go AI 库并完成录音 TOC 等功能。

管理实现为站点概览（含 LLM 任务计数）、账号字面搜索及启停/角色筛选、管理审计与最近7天的结构化运行异常。概览使用只读 Repeatable Read；日志 keyset 分页；运行异常有150ms单槽写入和恢复模式独立清理。原始错误、请求正文、转写和密钥不入日志。设计见 docs/research/administration/README.md。

采用 openai-go/v3 v3.81.0 的 ChatCompletionService，避免 SDK 环境变量继承；不引入 Eino/LangChain 编排。手动生成摘要和真实 segment 锚点章节，后台持久状态、全实例有效单任务、无自动重试。正文或时间修改后标记 stale；目录通过 anchor 分页定位，使用当前片段有效时间，不自动播放。

Herdr 原生 GPT-6.1 Sol 独立审查提出并已收敛：恢复快照必须隔离 queued 和 running，不能自动重放收费请求；章节时间可空，零时长也仅定位正文。还明确幂等键代次映射与删除回收、SDK环境隔离、输出4096 token上限。限定复核通过，两次本任务 Review pane 均关闭。设计见 docs/research/transcription-insights/README.md。

验证：隔离 PostgreSQL 下 scripts/test.sh 全通过（Go tests/vet、前端21单测/build、update-worker8测试、release4测试）。TestAdministrationInsightsBrowser 通过真实HTTP/PostgreSQL/浏览器链路，只有外部 LLM HTTP 为 fake；验证日志真实写入/筛选/分页、生成/失败再生成/stale、未加载章节音频定位、空时间、深色窄屏、普通用户403/业务404。

workbench.spec.ts 21项浏览器回归通过。Concord check、OpenAPI类型生成、git diff --check 通过。最后局部改动另跑相关Go测试、build和go vet。实际浏览器曾发现行内编辑后未刷新摘要 stale，已修正并复测。

没有调用真实收费模型、部署、commit或push。构建仍有大于500kB的bundle提示（631.8kB），不阻断构建。变更保留在 main 工作区，包含此前已授权的深色主题及账号页主题选择器。
