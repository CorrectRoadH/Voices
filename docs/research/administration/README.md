---
format: concord.document/v1
id: administration
title: 站点运行状态与日志设计
createdAt: 2026-10-18T14:01:48.358Z
kind: research
sources: []
---

# 站点运行状态与日志设计

## 对比与范围

本地 OpenTickly 的 package 名称为 opentoggl。其 `AdminOverviewTab.tsx` 有版本、账号和依赖健康展示，`AdminUsersTab.tsx` 有搜索及状态筛选。其健康接口将 job_backlog 固定为0，Voices 不采用占位统计。`AuditLogPage.tsx` 提供组织审计，不是容器日志查看器。

Voices 采用运行概览、账号筛选、管理审计和安全运行异常。保留账号启停、角色、注册开关、服务器配置与更新功能。不新增组织、SSO、邮件、任意 shell、容器 stdout 读取、在线恢复或跨用户业务数据访问。

## 入口与权限

管理员入口：`/admin/overview`、`/admin/logs`、`/admin/accounts`、`/admin/server`。日志以 shadcn Tabs 区分管理审计和运行异常。使用 Base UI、Tailwind、语义颜色，支持窄屏和深色。

普通用户没有导航入口，直接页面访问回录音库，API 返回403。读取使用既有 cookie session 和 no-store。写入继续遵守 CSRF、来源和恢复模式约束。管理统计只聚合数据，不返回录音标题、音频、转写、人物或远端资源ID。

## 概览 API

`GET /api/v1/admin/overview` 在2秒预算内，以显式只读 Repeatable Read 事务读取同一快照。查询失败返回503，不伪造零值；鉴权阶段数据库故障仍可能返回既有500。字段如下：

| 字段 | 含义 |
| --- | --- |
| checked_at | UTC 查询时间 |
| instance_id / started_at / uptime_seconds | 当前响应实例的身份和运行时间 |
| restore_mode | 当前实例恢复模式 |
| database | status=up 与 latency_ms，仅表示本次数据库可查询 |
| users | total、active、disabled、admins；admins 只计启用管理员 |
| storage.blob_bytes | 全部 ready blob 的字节数 |
| jobs | queued、running、retry_wait、failed、uncertain、restore_hold、stale_running |
| insights | LLM 摘要的 queued、running、failed 数量 |
| cleanup_failed | provider_resources 中 cleanup_state=failed 数量 |
| limits | max_upload_bytes、prepare_concurrency、transcription_concurrency |
| runtime_log_dropped | 本实例启动后未写入的运行异常次数 |

stale_running 是 running 中 lease_until 为空或过期部分。数据库可查询不代表 worker、外部服务或全集群健康。实例时间、限制与丢弃数可能随响应副本不同。页面手动刷新，显示快照时间与解释，不调用付费接口。

## 日志分页与过滤

两个日志 API 共用降序 `(created_at,id)` keyset 分页，返回 `{items,next_cursor}`。limit 默认50，范围1..100，读取 limit+1 判断下一页。cursor 是 base64url JSON，包含 RFC3339Nano created_at 和 UUID id；最大512字符，严格校验字段、类型及格式。

from/to 使用 RFC3339，分别包含起点、不包含终点；可单独指定，两者存在时须 from<to。非法参数返回400，SQL 参数化。页面筛选与刷新从第一页开始，上一页保存 cursor 栈，新增记录不使后续页面重复。

### 管理审计

`GET /api/v1/admin/audit-events` 筛选 action、actor_id、target_user_id、from、to。ID 须为 UUID。action 允许以下五类：

- account_updated：details 只投影 old_role/role 的 admin/user，以及 old_status/status 的 active/disabled。
- registration_updated：只返回 registration_open 布尔值。
- server_settings_updated：只返回 fields 中已知配置字段名。
- password_reset：details 为空对象。
- job_reconciled：只返回合法 job_id/operation_id UUID。

item 包含 id、created_at、action、actor、target、details。actor/target 可空，非空为当前账号的 id/email/display_name，不宣称历史身份快照。actor 为空表示服务器命令。

未知 action 使用通用展示，details 为空；绝不透传任意 JSON。配置字段白名单为 public_base_url、allowed_origins、soniox_api_key、assemblyai_api_key、llm_base_url、llm_model、llm_api_key。

沿用 admin_audit_events 表、事务写入及长期保留，不增加删除或导出接口。页面展示操作、时间、身份和可读变更。

### 运行异常

`GET /api/v1/admin/runtime-events` 筛选 kind、request_id、job_id、from、to，ID 须为UUID。item 为 id、created_at、instance_id、kind、code，以及可空的 request_id、route、status、job_id。

仅查询最近7天，即使物理清理滞后也不显示更老数据。页面支持请求ID，接受 URL request_id 参数；非法值明确报错，不能改成全量查询。job ID 只用于排障，不链接越权读取或重试。

## 账号筛选

`GET /api/v1/admin/users` 保持原响应和 offset 分页。q trim 后最多100字符，按邮箱、用户名和显示名做大小写无关的字面子串匹配；%与_不作通配符。

status 为 active/disabled，role 为 admin/user，非法值400。页面改变筛选后重置 cursor，提供空态及错误态。账号修改契约不变。

## 运行异常表

迁移009新增 runtime_events，不改变旧表语义。所有未标可空字段均 NOT NULL：

| 字段 | 类型与约束 |
| --- | --- |
| id | UUID PK，应用生成 |
| created_at | timestamptz，数据库 clock_timestamp 默认值 |
| instance_id | UUID |
| kind | text，限定五类事件 |
| code | text，最多64字符 |
| request_id / job_id | nullable UUID，无业务外键 |
| route | nullable text，最多200字符 |
| status | nullable smallint，500..599 |

kind 为 request_failed、job_failed、job_claim_failed、maintenance_failed、job_failure_persistence_failed。索引为降序时间/id，以及 kind、request_id、job_id 各自加时间/id；后两个为非空部分索引。

不保存 owner、邮箱、正文、原始 URL/query、cookie、header、服务商响应、堆栈、密钥或转写。HTTP仅记录匹配后的 r.Pattern 模板；stdout 同样移除原始路径。后台事件使用 internal 或 postgres:五位SQLSTATE，任务失败仅使用受控 provider/processing 错误码。未知码归 internal。

## 写入与清理生命周期

每个 App 有一个非阻塞写入槽。未取得槽立即增加 dropped；取得后同步 INSERT 一次，使用独立于请求取消的150ms上下文，随后释放。无队列、无后台写入 goroutine、无重试。

运行异常不参与业务事务。写入失败只增加 dropped，不递归记录，不改变原响应。App 内存只有写入槽和当前实例计数，持久事件在 PostgreSQL。

App.Run 用既有 wait group 拥有独立清理 goroutine；原子标志防止同 App 重复启动。启动时与每10秒清理一次，恢复模式也执行，不依赖任务领取或远端清理。退出取消并等待。

每批最多1000条、预算1秒，删除7天前记录，用 FOR UPDATE SKIP LOCKED 避免多实例互相阻塞。失败只输出安全 stdout。物理删除可滞后，7天承诺是可见窗口。审计不走此记录器，不自动删除。旧二进制可忽略新表回滚，降级不承诺继续清理。

## 独立审查与验收

原生 Codex / GPT-6.1 Sol Review 通过，无阻塞。收敛约束为只读 Repeatable Read、数据库时间+UUID keyset、恢复模式独立清理及退出等待；不以设计通过代替实现验收。

真实 PostgreSQL 验证权限、计数、审计入口与脱敏、日期/UUID/分页及同时间事件。HTTP handler 和 failJob 验证运行异常，覆盖跨实例读取、敏感路径不入库、写入槽丢弃、150ms超时与清理保留审计。

浏览器验证管理员实际写入可在日志读取、筛选分页、请求ID、空/错误态、普通用户入口隔离、深色和窄屏。执行 Go tests/vet、前端 tests/build、OpenAPI 类型生成与 Concord 检查。
