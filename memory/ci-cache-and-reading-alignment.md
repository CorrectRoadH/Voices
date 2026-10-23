---
format: concord.document/v1
id: ci-cache-and-reading-alignment
title: CI 下载缓存、E2E 分片与阅读对齐修复
createdAt: 2026-10-23T04:22:49.173Z
kind: memory
memoryKind: note
state: captured
epoch: 0
promotions: []
history: []
---

2026-10-23，主分支 CI 39895920834 与 v0.0.5 发布运行 39896251131 均在目录摘要场景失败。新增正文搜索位于正文滚动列内，使聊天区域比侧栏页签低 72px；原有对齐断言正确。搜索移到两列共同上方，并监听搜索区域尺寸变化重新计算阅读高度。

修复后隔离 PostgreSQL 上的 vp run check 通过；使用本机 Chromium 的 vp run test:e2e -run '^TestAdministrationInsightsBrowser/insights$' -timeout=12m 通过，约 236 秒。Concord、actionlint、分片校验与 diff 检查通过。初次本地验收因下载版 Chromium 缺少系统库而失败；整份 .env 注入干扰服务器配置测试，重新运行仅传隔离数据库配置。

CI 安装瓶颈来自 runner 实际 APT mirrorlist。修正镜像并缓存下载包后，媒体安装约 14–26 秒，缓存命中后的 Chromium 安装约 8 秒；原失败运行媒体安装约 18 分钟。缓存仅保存 .deb 与浏览器下载，不缓存系统状态或测试结果。不同 runner 网络条件影响耗时，不能将全部差异归因于缓存。

完整串行 E2E 约 33 分钟，因此按实际耗时分成 reading、accounts、settings 三组，每组独立数据库与浏览器，组内串行。scripts/check-e2e-shards.py 验证三个过滤器恰好覆盖默认入口的 11 组测试；遗漏与重复负向验证均被拒绝。完整远端分片验收与发布仍待完成。

用户明确批准修复后发布 v0.0.6。保留 v0.0.5 标签，不移动旧标签，不跳过发布门禁，不部署生产。

最终验收：Release 39900038306 全部成功，v0.0.6 于 2026-10-23T04:43:27Z 发布，目标提交 d1d086d。三个浏览器分片实际执行并通过全部 11 组场景。最长 reading 分片测试约 13 分钟、含准备约 14 分钟，accounts 约 10 分 24 秒、settings 约 11 分 5 秒；旧串行测试约 33 分钟。此前失败的目录摘要子场景在远端通过，约 262 秒。主分支原 CI 因后续独立提交而取消，发布自己的完整门禁通过。

GitHub Release 的 amd64/arm64 压缩包下载后 SHA256SUMS 均通过，amd64 二进制 version 输出 0.0.6。Docker Hub 0.0.6 manifest 同时包含 linux/amd64 与 linux/arm64。隔离测试数据库已删除；本轮无 pane、tab 或 worktree 残留，无生产部署。
