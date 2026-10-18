---
format: concord.document/v1
id: server-settings
title: 数据库优先的服务器配置设计
createdAt: 2026-10-18T05:43:55.133Z
kind: research
sources: []
---

# 数据库优先的服务器配置

## 目标与范围

管理员在 /admin/server 管理站点 Public Base URL、额外可信 origins、STT（Soniox / AssemblyAI API Key）、LLM（OpenAI-compatible Base URL、模型、API Key）。LLM 本期仅保存配置，不发起模型请求或新增摘要功能。实际 STT 适配器使用数据库配置。

## 持久化与优先级

新增 server_settings 单行表：id smallint PK CHECK id=1；revision bigint NOT NULL DEFAULT 1 CHECK >0。value_json jsonb NOT NULL；updated_at timestamptz NOT NULL DEFAULT now()。value_json 为固定 Go 结构，包含 public_base_url、allowed_origins、soniox_api_key、assemblyai_api_key、llm_base_url、llm_model、llm_api_key。无用户 owner，这是实例配置，不能复用个人 settings。

启动先加载工作目录 .env（已存在的进程环境优先于 .env），用环境取得 DATABASE_URL 并连接迁移。然后 INSERT 初始配置 ON CONFLICT DO NOTHING，再 SELECT 数据库配置。并发首启只有一个成功初始值，数据库存在时整份配置优先，包括空字符串；更改 .env 不能覆盖或复活已清除的密钥。只在缺少整行时导入和验证环境业务值，避免失效的旧环境阻断已有数据库配置。数据库失败不回退环境。数据库连接、监听、目录、恢复模式、上传限制及 worker 并发仍是基础部署参数，不入表。本次新增 LLM_BASE_URL、LLM_MODEL、LLM_API_KEY 及 LLM_API_KEY_FILE。

配置在启动时读取，进程内是不可变快照。保存只更新数据库，所有应用副本重启后采用新值。API 明确返回当前进程生效的脱敏配置和 restart_required；不可把单副本状态当全集群确认。重启会重新构造 STT adapters，后台清理与提交继续使用同一快照。API Key 轮换必须属于同一服务商账号，跨账号替换需先完成所有转写及远端清理，避免旧资源失去访问；UI 和运维文档明确此限制。

## API 与权限

GET /api/v1/admin/server-settings 返回 revision、saved（脱敏数据库配置）、active（脱敏启动快照）、restart_required。密钥只返回对应 *_configured 布尔值，既不返回原文也不返回尾号。PATCH 同路径接收 revision 必填及白名单可选字段；省略密钥保留，空字符串显式清除，非空字符串替换；null 和未知字段拒绝。以 SELECT FOR UPDATE 校验 revision，更新并递增；同事务写 admin_audit_events，details 只有修改字段名，不含旧/新值。

返回相同脱敏结构。并发过期 revision 返回 409。沿用 admin / CSRF / Origin 检查和 restore mode 禁写。

URL 限 http/https，需绝对地址，不允许 userinfo/query/fragment/空白，限制长度；Public Base URL 保留既有路径支持但拒绝非规范路径（点段、重复斜杠、编码路径）。LLM Base URL 可含 /v1 路径，空值允许；model 最大 200 字符且无控制字符；密钥最大 8192 字符且无控制字符。allowed_origins 只能是精确 origin，去重最多 32 个。保存不访问配置 URL，因此无 SSRF 探测功能。LLM 字段可独立填写，UI 明确配置完整性不代表已验证可用。

## 安全边界与部署

密钥由环境专有存储迁为数据库秘密：数据库角色、备份和副本必须按含凭据保护；不宣称应用层加密。浏览器仅发送用户新输入密钥，保存后清空输入；日志、审计、错误及读取 API 不输出密钥，URL 不允许内嵌凭据。数据库管理员原本可修改应用数据与账号，现在也可读取服务商密钥，这是显式信任边界变更。仅管理员能管理此表。

Base URL 路径变更要求前端构建 BASE_URL、代理和健康检查同步。根路径 /healthz 始终提供只读健康检查，不依赖可变的站点路径；容器 healthcheck 使用此固定路径，避免已保存但尚未生效的地址导致健康检查失败。文档列出重启前配套步骤与以数据库修复地址的恢复方式，不提供环境强制覆盖后门。此次不实际部署或重启用户服务。

## 验收

真实 PostgreSQL 验证首启导入、并发初始值、重启数据库优先、清除值不回退环境、非法旧环境不阻断既有配置；管理权限/CSRF/恢复禁写/非法值/null/过期 revision。响应与审计不泄漏密钥；构造新应用后的 STT adapters 使用新凭据（fake 只在 HTTP 服务商边界）。前端验证管理员入口、字段保存、留空保留与显式清除、保存后清空密码、待重启状态和普通用户不能访问。Go tests/vet、前端 tests/build、Concord check 与定向浏览器验收。

## 设计状态

用户明确指示本次无需独立挑战，按上述契约直接实施。验收覆盖数据库秘密边界、启动优先级、生效方式和健康检查。
