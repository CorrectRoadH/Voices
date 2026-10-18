---
format: concord.document/v1
id: accounts-acceptance
title: 独立账号实现与验收
createdAt: 2026-10-18T03:01:09.154Z
kind: memory
memoryKind: note
state: captured
epoch: 0
promotions: []
history: []
---

# 独立账号实现与验收

用户确认每账号独立、首个注册者为管理员，并明确豁免本次独立审查，由主 agent 实现和验证。Herdr 父 pane 已不存在，未创建 worker 资源。用户随后要求密码不必复杂、完工后清空开发库。

实现用户名和密码注册、数据库锁保证首位管理员唯一、用户会话、账号管理、个人密码与本机重置命令。账号 owner 覆盖资源链条，列表和幂等按账号隔离，复合外键阻止跨账号关联。管理员不绕过业务内容归属。密码最少 6 字符，无复杂组合要求，bcrypt 最大 72 字节。

共用服务商密钥下，未知远端 ID 只允许本机运维核实并登记，网页只能记录观察或确认已有 ID，防止跨账号读取远端数据。非空历史业务库拒绝自动迁移，不自动归给首位注册者。

验证：使用开发 PostgreSQL 中自动创建并清理的随机 schema，`sh scripts/test.sh` 完成 Go 集成测试、go vet、21 项前端单元测试、类型检查及构建。增加并发首位注册、并发最后管理员保护、全业务路由交叉越权、相同音频/幂等键隔离、偏好隔离、会话撤销和迁移拒绝测试。实际 `go run ... reset-password` 已在独立 schema 验证。

真实浏览器 `TestBrowserFullStack` 通过导入、转写、编辑、人物、导出与深链接。`TestAccountsBrowserFullStack` 使用 123456 完成首位与后续注册、独立上传、改密码登录退出和关闭注册。前端边界 E2E 先通过 8 项，修正旧冲突错误码 fixture 后针对性复跑剩余 1 项通过。新注册开关在异步保存时更新显示，失败回退。仅替换外部 STT HTTP，未发起真实付费调用。

Concord check/doctor 通过。按用户明确要求清空 voices-dev 开发库业务表、用户、会话、审计和限流桶，重置初始化与开放注册标记，保留结构与迁移记录。读取核对 users/recordings/people/blobs/jobs/sessions 均为 0，initialized=false。真实浏览器打开局域网前端确认显示创建管理员账号和 6 字符规则，没有注册账号。

用户启动的 Air/Vite 与开发 PostgreSQL 保持运行。新增 pane/tab/worktree：无。没有提交、push 或生产部署。
