---
format: concord.document/v1
id: oidc-login-acceptance
title: 站点 OIDC 登录实现与验收
createdAt: 2026-10-26T06:55:59.236Z
kind: memory
memoryKind: note
state: captured
epoch: 0
promotions: []
history: []
---

# 站点 OIDC 登录实现与验收

2026-10-26 完成站点级 OIDC 登录、管理员自动保存配置、主动绑定解绑和无本地密码账号的密码恢复。契约见 `docs/feature/accounts/use-case/oidc-login.md`，具体设计、独立审查结论及部署/回滚要求见 `docs/feature/accounts/oidc-design.md`。

实现前通过 Herdr 启动原生 Codex / GPT-6.1 Sol 独立审查，收敛 subject 校验、UserInfo 同一主体与邮箱验证声明一致性、显示名称长度以及事务锁顺序。审查 pane 已回收。

验证使用本轮独立 PostgreSQL 数据库与系统 Chromium。OIDC fake 仅模拟外部身份平台，应用、数据库、签名验证、PKCE 和浏览器跨站跳转均走真实入口。专项测试覆盖配置权限与密钥脱敏、无效令牌、重放、浏览器绑定、配置变更、并发建号、会话撤销、恢复模式、子路径，以及绑定/解绑/本地密码设置。`TestOIDCFirstPasswordRejectsRevokedSession` 通过数据库锁制造竞态，确认已撤销会话不能设置首个密码。

新增自然语言浏览器场景单独通过，并在全量入口再次通过。最初浏览器验收修正了测试侧读取受保护密码字段和本地登录后跳转位置的错误假设；最终场景以服务端脱敏响应和实际页面状态验收。

最终验证结果：

- `TEST_DATABASE_URL=<isolated database> vp run check` 通过（9/9），包含 Go 测试、前端和 worker 检查/测试、release 检查、Go vet 及前端构建。
- `TEST_DATABASE_URL=<isolated database> VOICES_BROWSER_TEST=1 E2E_CHROMIUM_EXECUTABLE_PATH=<system chromium> vp run test:go -run '^TestOIDCBrowser$' -v` 通过；新增浏览器场景还在全量入口再次通过。
- `TEST_DATABASE_URL=<isolated database> E2E_CHROMIUM_EXECUTABLE_PATH=<system chromium> vp run test:e2e` 执行完毕，13 个顶层场景中 12 个通过，1 个失败，总入口返回非零。通过项包括 OIDC、管理后台、账号、转写工作台、交互、恢复、语言、模型、初始化、引用、服务器设置和更新。
- 唯一失败为本轮未修改的 `web/tests/calls.e2e.ts:18`：自然语言测试已展开详情并两次点击刷新，但因页面内容未变，模型以“无法验证刷新已生效”返回失败。证据只能确认这一测试判断失败，不能据此断言刷新产品行为损坏。原始 trace 位于本地 `web/.e2e/calls/results/calls-22cba2a558403647/trace.md`。没有为使全套变绿而修改无关场景或重复整套回归。
- API 生成一致性检查通过；`concord check --json` 通过；`concord trace gaps --fresh --json` 已检查，新增 OIDC 关系完整，既有无关关系缺口不代表本轮覆盖失败；`python3 scripts/check-e2e-shards.py` 确认 13 个场景各覆盖一次；`git diff --check` 通过。

未部署生产，未配置真实身份平台。现有静态检查警告、构建体积警告及浏览器字体 CSP 日志没有作为本任务扩展修复范围。
