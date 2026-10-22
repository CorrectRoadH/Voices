---
format: concord.document/v1
id: job-recovery-diagnostics
title: 任务恢复入口与安全错误诊断
createdAt: 2026-10-22T14:40:50.482Z
kind: memory
memoryKind: insight
state: current
epoch: 0
promotions: []
history: []
---

用户要求完善任务恢复操作、显示具体原因并 push；另明确授权 kubectl 只读调查线上任务。

只读调查：任务 c9300a43-2daa-40ad-9b59-e99ce49a46cf 于 2026-10-22 14:17:54 UTC 进入 uncertain/uploading；仅有一条 upload uncertain 操作，无远端 ID；Pod 自 2026-10-21 运行且 restartCount=0。runtime_events 仅保存 uncertain，没有 HTTP 状态和原因；近 30 分钟日志未提供额外错误。因此不能判断该次具体是超时、断连还是异常响应。未修改线上状态，未触发收费请求。

错误原因丢失发生于两层：HTTP 适配器将异常压成分类码，remoteCreate 又重建 uncertain 错误。现在提供白名单诊断并贯穿这两层，jobs.error_detail 保存最近失败 reason/HTTP 状态，阶段推进与手动重试清除；不存原始 URL、响应正文或 error。历史任务不伪造原因。

任务页与录音正文直接提供重新转写；复用既有重复收费确认与幂等创建，保留旧 uncertain 及资源操作。安全重试由后端资源状态投影 retry_allowed 决定，事务写入仍重新校验，恢复模式拒绝写入。音频 ready 文案明确为音频已就绪。

验收：隔离本地 PostgreSQL 的 vp run check 通过；vp run test:recovery 使用真实 Go/PostgreSQL/Chromium，仅 fake 服务商边界，确认取消不提交、风险确认后仅一条新版本、旧 uncertain 保留、HTTP 401 上传可安全重试。concord check 和 git diff --check 通过。现存非阻塞问题：lint warnings、大 bundle 提示、浏览器已有 data font 被 CSP 拒绝的控制台报错。未执行全套需模型的自然语言 E2E；本次恢复验收不需要模型。
