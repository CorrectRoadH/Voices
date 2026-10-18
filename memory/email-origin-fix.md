---
format: concord.document/v1
id: email-origin-fix
title: 邮箱登录与开发来源修正
createdAt: 2026-10-18T03:14:42.006Z
kind: memory
memoryKind: note
state: captured
epoch: 0
promotions: []
history: []
---

# 邮箱登录与开发来源修正

用户在首次注册页面遇到 origin_rejected，并要求使用邮箱、用户名。按邮箱作为登录标识、用户名仅作显示实现，密码继续至少 6 字符。没有发送验证邮件或声称验证邮箱所有权。

原配置仅允许 PUBLIC_BASE_URL 的 LAN 来源，localhost 浏览器 POST 被拒绝。新增显式 ALLOWED_ORIGINS，拒绝任意 Host、通配符、带路径的 origin 与 cross-site 请求。开发配置允许 localhost:5173、127.0.0.1:5173、机器实际 Tailscale 地址 100.67.1.82:5173，原 LAN 来源仍允许。未获得用户实际浏览器 URL；自定义域名仍须显式配置。

003 邮箱迁移仅在 users 为空时执行，不伪造既有账号邮箱。修改注册、登录、会话、管理界面、密码恢复 CLI 和 OpenAPI。一般服务错误不再把邮箱和密码都标成无效。

验证：真实数据库 Go 测试、go vet、21 项前端测试、类型检查和构建通过。新增邮箱格式、大小写与重复身份测试，Origin 白名单与拒绝非法配置测试通过。真实浏览器全栈业务和邮箱账号流程通过；账号流程显式使用与 PUBLIC_BASE_URL 不同但已允许的 origin。带前缀的登录深链接 E2E 通过。

现场浏览器 localhost 页面使用邮箱字段提交过短密码，得到 invalid_password 而非 origin_rejected，且仅密码字段标红；未创建账号。Tailscale 来源也通过校验。开发数据库 users=0、bootstrap_completed=false，保持首次注册资格，不再次清除用户业务。用户启动的服务保持运行，无新增 pane/tab/worktree。
