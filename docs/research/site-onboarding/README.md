---
format: concord.document/v1
id: site-onboarding
title: 注册与站点初始化分离
createdAt: 2026-10-20T02:18:30.229Z
kind: research
sources: []
---

# 注册与站点初始化分离

## 目标与现状

注册只创建账号。首次管理员注册后进入独立 /onboarding，配置 LLM、获取模型、显式测试并完成站点初始化。部署不依赖 .env 文件；DATABASE_URL（或 _FILE）及非默认部署所需 PUBLIC_BASE_URL 等基础参数仍由环境提供。LLM 不再是部署模板的输入要求，旧环境首启导入保留兼容。

现有 auth.go 的 bootstrap_completed 仅标记首位管理员资格已消费。server_settings 保存数据库但实例配置只在启动时读取；insights.go 生成任务使用实例配置且只持久模型名。

## 数据与迁移

使用新增 013_site_onboarding.sql（012 留给已有隔离目录迭代工作）。instance_settings 增加 site_setup_completed boolean NOT NULL DEFAULT false；迁移时已有 bootstrap_completed=true 的站点置 true，避免升级锁住既有用户。全新站点默认 false，首个管理员注册只更改原 bootstrap_completed。两者不可互换。

server_settings 增加 llm_test_revision bigint NULL：仅代表此配置修订已通过真实生成协议测试。任意设置修改都清除它（保守失效）；测试开始读取修订，成功时 CAS 更新，修改中的旧测试不得授权新配置。

transcription_insights 增加 llm_config_json jsonb NULL，存提交时 {base_url,api_key,model} 快照，含秘密，不通过 API/日志/审计返回。完成、失败、超时、恢复隔离时与 input_json 一起清除。迁移前 queued/running 无快照的任务标 interrupted，不自动调用模型，不猜测旧凭据。需要停止旧版本应用后升级，不能混用新旧 worker。

## 权限与流程

GET /auth/status 增加 site_setup_completed；registration_open 在管理员已创建但初始化未完成期间为 false，首次管理员注册仍可用。POST /users 在同一 instance_settings 行锁下阻止初始化未完成时的后续注册。保留首位并发唯一性与失败回滚。

已登录管理员通过 GET /admin/onboarding 读取 {completed,revision,llm_tested}，站点未完成时前端进入独立 onboarding（退出登录仍可用）。普通用户永远没有配置入口；已完成站点的新用户直接进入工作台。恢复模式不强制 onboarding，所有写入仍被恢复保护拒绝。

POST /admin/onboarding {revision,skip_llm:boolean}：管理员、CSRF、来源和恢复模式保护。事务中 lockAdmin 先锁 instance_settings 并复核管理员，再锁 server_settings；后续读取 instance_settings 复用已有锁。revision 必须一致。启用 LLM 必须地址/模型非空且 llm_test_revision 等于当前 revision；skip_llm 仅当 LLM 地址、模型和密钥全空有效，避免隐式接受未测试配置。完成只写 site_setup_completed=true 并审计，不改变账号资格或注册开关。重复同修订完成幂等。

初始化中保存配置不代表完成，刷新/退出后可继续。已完成站点编辑配置不会重新锁定站点。

## 配置和测试 API

沿用 PATCH /admin/server-settings 的 CAS、自动保存与密钥不回显。LLM 地址变更且已有密钥时必须显式提交 llm_api_key（新值或空），否则拒绝，防止旧密钥被隐式发送到新目标。

POST /admin/llm-test {revision} 仅测试已保存配置，不接受任意测试正文；固定无隐私的短转写，通过现有 insights.Generate 验证 Chat Completions、JSON 和片段引用协议。显式按钮告知会产生一次模型调用；限时 20 秒、无自动重试、限制响应大小且拒绝重定向，使用现有错误脱敏。每管理员每分钟最多 3 次。成功只返回 {revision,tested:true}，不返回模型正文或秘密；失败保留配置，不设置通过状态。模型列表仅发现，不代表测试通过。

GET /admin/server-settings 的 active LLM 字段反映最新数据库配置，restart_required 只对站点/STT 等仍按启动生效字段比较。LLM 新任务在提交事务内读取 server_settings 并持久不可变快照，多实例一致；worker 只使用快照，不读可变全局 Config。运行时不修改 App.Config，不产生并发写竞争。无配置或数据库错误分别返回具名拒绝或失败，不从环境回退。测试构造器应显式导入测试配置而非增加生产 fallback。

## 界面与部署

onboarding 复用现有服务器表单，呈现站点、STT 和 LLM 卡片，展示配置保存、测试状态、完成/暂不启用操作。按钮等待自动保存完成并绑定最新 revision；变更立即清除前端成功标记。获取模型沿用已有 ModelPicker。完成后刷新 session/状态进入工作台。管理员日后可在服务器设置再次测试。

保留基础 PUBLIC_BASE_URL 的可信来源约束，不从未受信 Host 自动推导，不把来源策略随 LLM 热更新。STT 与站点参数在初始化页和现有设置页均可管理并明确重启要求。本次不修改转写 provider 资源生命周期。compose、README、operations、.env.example 将 LLM 从部署步骤移至浏览器初始化，.env 仅可选便利方式。

## 验收

真实 PostgreSQL 验证首次注册与站点完成分离、并发只有一个管理员、初始化期间后续注册受阻、权限/CSRF/恢复模式、重进恢复、完成 CAS、测试失败/旧响应失效、空配置显式跳过、旧站点迁移保留访问。外部 LLM fake 验证一次真实协议请求、无重试、密钥不外泄、测试通过/失败、保存后无需重启、已排队任务快照及终态清理。真实 Go/PostgreSQL 浏览器流程覆盖中文 onboarding 与普通注册分流，已有 E2E 按新流程调整，不伪造业务 API。执行 Go 针对测试、前端 typecheck/build/test、Concord check/trace 和项目必要检查。未调用真实付费模型、不提交/push/部署。

## 关键取舍

LLM 运行配置按任务快照绑定，避免修改可变 App.Config 或保留跨副本缓存。站点地址与 STT 保持原生效边界，避免扩大来源授权和远端资源生命周期变更。任意设置修订均清除测试标记，以保守失效换取明确的测试/完成 CAS 语义。升级前停止旧 worker，升级后不自动重放无凭据快照的历史任务。
