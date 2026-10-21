---
format: concord.document/v1
id: site-onboarding-acceptance
title: 站点初始化与注册分离验收
createdAt: 2026-10-20T02:34:58.406Z
kind: memory
memoryKind: note
state: captured
epoch: 0
promotions: []
history: []
---

# 站点初始化与注册分离验收

2026-10-20 用户要求部署不依赖 .env 文件，数据库等基础配置仍必需，LLM 在首次 onboarding 填写并测试。独立 Review 曾因当前 Herdr pane 不存在受阻，用户明确要求本任务跳过审查直接实现；未启用 worker，也未把该例外作为全局规则。

## 实现

[初始化契约](../docs/feature/accounts/use-case/setup-site.md)与[设计](../docs/research/site-onboarding/README.md)确定账号 bootstrap 与 site_setup_completed 独立。首次管理员注册后进入 /onboarding，站点未完成暂停后续注册，普通账号注册不配置站点。旧站点升级自动保留完成状态。

初始化页复用站点/STT/LLM 表单；LLM 测试绑定数据库修订，使用固定示例和现有生成协议，20 秒超时、无自动重试、每管理员每分钟最多 3 次。配置改变使测试状态失效，旧在途成功不能确认新修订。空配置可明确跳过 LLM。变更地址要求显式新密钥或清除原密钥。

LLM 新任务从数据库读取并持久化秘密配置快照，排队任务保留提交时目标；完成、失败、超时、账号禁用及恢复隔离清除快照。站点/STT 保持重启生效。部署模板移除 LLM 参数，README 使用进程环境提供数据库密码，.env 仍可选。

迁移 013_site_onboarding.sql 要求停止旧实例再升级；既有无配置快照的 queued/running 摘要任务标记 interrupted，不自动收费重放。未合并其它 worktree 的目录实现。

## 验证与限制

在本轮独立 PostgreSQL（127.0.0.1:55483/voices_onboarding_test）运行 `TEST_DATABASE_URL=... sh scripts/test.sh` 全部通过：Go tests/vet、24 项前端单元测试、typecheck/build、更新服务检查和 10 项测试、4 项发布脚本测试。

补充 `TestDeploymentWithoutDotenvOrLLMCredentials` 通过，验证缺失 .env/LLM 配置仍可初始化、数据库连接仍必填。

8 项真实 Go/PostgreSQL + 系统 Chromium 浏览器流程最终均通过。完整批次有 3 项旧预期/流程失败：模型仍期待重启、onboarding 未关闭模型下拉、更新页未完成初始化。修正后只复跑相关项；模型与 onboarding 复跑通过，onboarding 手机深色和更新页最终复跑通过。外部 LLM/STT/更新服务使用 fake，业务 API 与数据库为真实实现；未调用付费模型。

`concord check --json`、`concord trace check --json`、`git diff --check` 通过。trace gaps 保留原有 6 项缺失关系，新增初始化用例具有明确代码与测试关系；关系检查不代表覆盖率。

浏览器仍出现既存 data: 字体 CSP 拒绝日志，未扩大范围修改字体策略；不影响本轮流程断言。构建仍有 bundle 大小提示。截图与报告在 web/.e2e/。

本轮无提交、push、部署；保留进入任务前的未知改动。无新建 pane/tab/worktree；验收完成后停止并清理隔离测试 PostgreSQL。
