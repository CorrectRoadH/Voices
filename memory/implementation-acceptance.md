---
format: concord.document/v1
id: implementation-acceptance
title: 应用实现与本地验收
createdAt: 2026-10-18T02:09:23.395Z
kind: memory
memoryKind: note
state: captured
epoch: 0
promotions: []
history: []
---

完成可运行的 Go / PostgreSQL / Vite+ React 应用，前端使用官方 shadcn Base UI 源码。
数据库迁移、音频分块、会话、任务租约、远端意图、人物、版本、片段校正与深链接均已实现。

主 agent 负责后端和最终集成。两个原生 Codex GPT-6.1 Sol worker 分别实现前端和服务商适配，均经主 agent 检查与验证后回收。
worker 曾被建在错误工作区，已移动到 Voices；两处原标签页自动关闭，最终标签页也已关闭。

验证命令与结果：

- `sh scripts/test.sh`：在真实 PostgreSQL 上通过 Go 测试、vet、21 个前端单元测试、类型检查和构建。
- `pnpm --dir web test:e2e`：9 个浏览器用例通过，覆盖前缀、登录返回、分页锚点、复制回退、上传和任务核对。
- `VOICES_BROWSER_TEST=1 go test ./internal/app -run TestBrowserFullStack -v`：真实浏览器、Go API、PostgreSQL 与 FFmpeg 链路通过；只替换外部 STT HTTP。
- `VOICES_LARGE_TEST=1 go test ./internal/app -run TestLargeHTTPUploadsBoundedMemory -v`：1073741868 和 2146435072 字节上传通过，Go 堆峰值约 8 MiB。
- `docker build -t voices:acceptance .` 与本地只读容器验证通过。移除实例 A 后，B 保留会话、完成预处理、播放 Range 和提供静态前端。
- `concord check`、`concord doctor`、`concord trace check` 均通过。

Concord 命令收据 `ccev_ab9f612089833edd3baff9ca319d07a8` 为 command scope，exitCode=0、cleanupOk=true、execution=unknown。
它记录整套命令成功，不代表单个原生测试被 Concord 单独选择。实际测试结果以上述执行输出为准。

Concord 的代码声明解析器仅支持 JS/TS。无状态 Feature 与 Use Case 仍显示缺少显式 code 关系；对应 Go 实现和真实数据库测试存在，不能把工具关系缺口称为实现缺失或覆盖证明。

关键验收包括：远端提交响应丢失不重复提交、观察记录不解除删除阻塞、晚到 ID 可登记、旧租约不能发布、恢复快照缺操作也进入隔离。
恢复时为缺失的 upload/submit 意图建立待核对记录，prepared 也不视为未发送；仅在核对完成后查询既有远端任务。

AssemblyAI 不支持独立上传文件删除；仅成功删除关联转写后，根据官方契约标记关联音频已清理。孤立上传保留告警，不将 TTL 视为删除证据。
未调用真实 Soniox / AssemblyAI 付费 API，因此服务商真实识别效果和账号权限未验收。

本轮没有提交、push 或生产部署。运行与恢复步骤见 README.md 和 docs/operations.md。
