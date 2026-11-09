# 账号与服务器配置接口

账号、会话、配置与初始化字段以 [OpenAPI](../../api/openapi.json) 为准。登录标识和权限见[实现接口契约](../../api/implementation-contract.md#账号与权限)，配置持久化见[服务器配置架构](architecture/server-settings.md)。

## LLM 模型发现

`POST /api/v1/admin/llm-models` 接收 `{base_url,api_key?,revision}`，返回 `{items:[{id}]}`。此入口服务于[管理服务器配置](use-case/manage-server.md#discover-models)。仅已登录管理员可调用，要求 CSRF、可信来源和当前配置修订；恢复模式禁止调用。

`base_url` 为规范 HTTP(S) 绝对地址，可含 `/v1` 路径。`api_key` 省略时复用已保存密钥；显式空字符串表示无认证，null 拒绝。已有密钥且目标地址变化时，必须明确提供新密钥或空字符串，不能隐式向新目标发送旧密钥。

服务端只执行一次 `GET <base_url>/models`，非空密钥使用 Bearer 认证，不跟随重定向、不自动重试、不继承 SDK 环境。超时 15 秒，响应最多 1 MiB、最多 1000 个模型。模型 ID 非空、最多 200 字符，不含首尾空白或控制字符；结果按 ID 去重并排序。空列表可返回成功。

发现不保存配置、不生成内容，也不将配置标记为测试通过。列表不保证模型支持 Chat Completions 或 JSON 输出；正式测试由[站点初始化的测试接口](architecture/onboarding.md#配置和测试-api)定义。

| 错误 | 条件 |
| --- | --- |
| `invalid_llm_base_url` / `invalid_revision` / `invalid_api_key` | 地址、修订或密钥格式非法，返回 400 |
| `saved_key_target_changed` | 目标改变却省略已有密钥，返回 400 |
| 修订冲突 | 读取的配置修订已过期，返回 409 |
| `model_list_timeout` | 请求超时或被取消，返回 502 |
| `model_list_unauthorized` | 上游拒绝认证或授权，返回 502 |
| `model_list_unsupported` | 上游不支持列表接口，返回 502 |
| `model_list_invalid` / `model_list_too_large` | 格式非法或超出响应、数量限制，返回 502 |
| `model_list_unavailable` | 其它受控上游失败，返回 502 |

响应与错误不返回密钥或上游原始正文。调用尝试遵循[外部调用记录](../call-logs/README.md)，日志写入失败不能启动尚未发出的请求。

验收核对权限、修订、密钥与目标绑定、超时和重定向拒绝，以及发现前后已保存配置与测试状态不变。
