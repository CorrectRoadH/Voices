---
format: concord.document/v1
id: server-settings-acceptance
title: 数据库优先的服务器配置与验收
createdAt: 2026-10-18T05:52:08.900Z
kind: memory
memoryKind: note
state: captured
epoch: 0
promotions: []
history: []
---

# 服务器配置实现与验收

用户明确要求数据库配置优先于 .env，管理站点、LLM 和 STT，并在 Herdr pane 失效后明确指示本次跳过独立挑战直接开工。实现遵循 [服务器配置契约](../docs/feature/accounts/use-case/manage-server.md)与 [设计](../docs/research/server-settings/README.md)。

完成服务器设置页面、管理员 GET/PATCH、修订冲突保护、字段名审计、单行数据库配置和首次环境导入。STT 生产适配器通过 NewServer 取得数据库密钥；保存后重启全部副本生效。LLM 仅提供配置，不新增模型调用。

使用本机 PostgreSQL 的隔离测试 schema，运行 `CGO_ENABLED=0 sh scripts/test.sh`（设置 TEST_DATABASE_URL），Go tests/vet、21 个前端测试与前端构建通过。新增定向测试验证数据库优先、并发初始化、并发保存单一胜出、秘密不回显、权限/CSRF/恢复禁写和两个 STT 适配器发送的凭据。

`VOICES_BROWSER_TEST=1 go test ./internal/app -run '^TestServerSettingsBrowser$' -count=1 -v` 在真实 PostgreSQL、Go handlers 和 Chromium 上通过。验证保存、刷新持久化、留空保留、明确清除、重启提示、移动宽度与普通用户拒绝；仅服务商 HTTP 边界使用 fake，没有调用付费外部服务。

完整检查之后健康检查改为读取 .env 中的监听参数，补充了并发保存测试；对应 Go 测试、Go vet 和 concord check 再次通过。构建仍有大于 500 kB 的 bundle 提示，不影响构建成功。已有四个 Concord code 关系缺口保持原状，新增管理用例的代码和测试关系完整。

没有提交、push、手动重启或部署服务，没有创建 pane/tab/worktree。仓库开始时所有源码均为未跟踪状态，保留现场。
