# OpenAI 直接转写的执行与恢复取舍

## 目标与边界

新增 OpenAI 文件转写，保留 Soniox/AssemblyAI 现有上传、提交、轮询和远端清理语义；管理员可在服务器设置配置独立 OpenAI STT 地址与密钥，用户在既有转写选项选择服务商/模型。LLM 设置增加从当前表单连接获取模型 ID 并在输入框下拉选择，仍允许手填。直接转写不自动触发摘要；本页不授权真实付费调用或部署。

## 证据

- `internal/providers/types.go` Adapter 强制 Upload/Submit/Poll/FetchResult/DeleteResource；`internal/app/job_steps.go` remoteCreate 将请求与可清理远端资源关联。OpenAI `/audio/transcriptions` 直接返回结果，不提供这些持久远端 ID，不能伪造文件/任务。
- `internal/app/jobs.go` 对过期 lease 可重新领取；`jobs_http.go` 重试和恢复按 provider_operations 判断是否可重放。直接请求需要独立的 durable 防重放标记。
- 当前网页要求说话人区分（options.tsx）；首批只暴露 `gpt-4o-transcribe-diarize`，保留按服务商选择模型的通用结构，不能把不支持说话人的普通模型标为兼容。
- 官方资料（2026-10-19）：[转写指南](https://developers.openai.com/api/docs/guides/speech-to-text)。Diarized JSON 提供 speaker/start/end；>30 秒指定 chunking_strategy=auto；文件上限 25 MB。
- [创建转写接口](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)。
- [模型列表接口](https://developers.openai.com/api/reference/resources/models/methods/list)。

## Provider 与任务契约（待独立审查）

`providers.Adapter` 只含 ID/Models。`AsyncAdapter` 嵌入 Adapter 并保留原六步方法；Soniox/AssemblyAI 构造器返回 AsyncAdapter。`DirectAdapter` 嵌入 Adapter 并提供 `Transcribe(context.Context, io.Reader, string, int64, Options) (Result,error)`，无资源清理 API。App Providers 仍为 map[string]Adapter，执行分支和远端资源清理显式检查相应接口；已有 fake async adapter 无语义变化。

迁移 `011_direct_transcription.sql` 只为 jobs 新增 nullable `direct_request_started_at timestamptz`（无默认、无需索引）；保留既有 RLS 与所有权。它表示该 job 已取得唯一直接调用许可，不证明请求被受理或计费。读音频成功后，在 fence 事务内将 NULL 更新为 clock_timestamp；事务提交后才可调用外部服务。任何再次执行若标记非 NULL，失败为 direct_request_interrupted，绝不重放。发送许可和外部请求间 crash 允许保守失败。

直接请求不调用 remoteCreate，不写 provider_operations/provider_resources，不伪造远端 ID。正常结果使用共用的归一化校验与 fenced publish 原文 blob、片段、说话人及成功状态事务。标记与现有 lease 确保双实例不双发。收到响应但保存前 crash 会丢失结果，允许用户明确创建新转写版本，说明可能重复收费；不自动补发。

直接请求 deadline 为 30 分钟，执行 heartbeat 沿用现有 job。取消、删除和租约丢失取消本地 HTTP；不承诺取消服务商处理。fenced publish 拒绝晚到结果，关闭 blob reader，无远端资源需清理；不因不可获取的远端 ID 永久阻塞删除。网络错误、429、5xx、非法结果、超时均以非自动重试的 direct_* 错误结束；同一 job 的 retry API 在 direct_request_started_at 非 NULL 时返回 409，提示新建版本及可能再次收费。若在发送许可前发生本地错误，原失败/重试边界保留。

恢复：所有未完成的 OpenAI transcribe job（含快照中尚未发送的 queued job）隔离为 failed/direct_request_interrupted，清 lease、递增 generation。同步 transcriptions 状态，不创建 upload/submit 不确定意图。已成功结果保留。其它 providers 恢复契约不变。恢复模式本身仍禁止新提交。OpenAI 不接受手工 remote ID reconcile；无远端资源可通过这个入口恢复。

## OpenAI HTTP 与能力

独立 `openai_stt_base_url`、`openai_stt_api_key`，环境首次导入对应 OPENAI_STT_BASE_URL/OPENAI_STT_API_KEY[_FILE]。默认地址 https://api.openai.com/v1；已有数据库缺字段视为空，UI 明示默认官方地址并保存。空地址在调用端使用官方默认，空 key 禁用（不借用 LLM key）。地址使用现有规范 HTTP(S) URL 校验，允许管理员自托管兼容服务；禁止重定向转发凭据。使用 explicit config，无 SDK 环境默认，无自动 retry。

首批模型 gpt-4o-transcribe-diarize，diarization/timestamps=true，最大 25,000,000 字节；语言 auto/single，固定维护官方支持语言，不冒充支持多语言 hints。请求固定 diarized_json、chunking_strategy=auto，单语言附 language；multipart 流发送且保持 reader 所有权，响应限 64 MiB。支持官方格式扩展名；不支持或超限在网络调用前给出明确错误，不自动切片（跨片说话人合并无既定语义）。输入原始音频不转码，现有导入和重新转写选项做同样限制校验，worker 再验证。

结果 segments 非空；每项 text string、speaker 非空、start/end 有限且非负/end>=start，按返回顺序入库，不杜撰说话人或时间；秒转换毫秒，共用检查 end<=duration+1000。错误只提供受控 code，禁止把 provider body/key 返回用户或日志。

## 已采用的相关能力

LLM 模型发现由[服务器管理用例](../feature/accounts/use-case/manage-server.md)声明，不属于本页待决范围。直接转写方案尚未采用，不能据此改变服务商执行模型。

## 验收

- Adapter HTTP fake 验证 multipart 参数、显式 credentials/环境隔离、格式/文件限制、响应结构/时间校验、无重试/无重定向/限流和超时、reader 关闭与取消。
- 隔离 PostgreSQL + 正式 App 初始化/HTTP/worker：配置保存重启/catalog；OpenAI 成功归一化持久化；失败不重发。验证 stale lease、双实例、cancel/delete fence、恢复 queued/running 不重放、无远端资源、retry/reconcile 拒绝不安全路径；原 async 回归。
- LLM 模型发现真实 HTTP fake + admin HTTP：权限/CSRF、revision、密钥不回显、同地址复用与换地址阻断、空 key、新 key、invalid/oversize response、redirect/错误受控、GET only。
- 浏览器 E2E：STT 配置卡片与导入/重转模型选择、能力限制；LLM 获取/输入框内选取/手填、失败/空列表、连接变化废弃旧结果；手机/深色；typecheck/build、go test/vet、Concord check 与 OpenAPI 类型同步。所有真实收费调用不执行。

## 审查

待原生 Codex / GPT-6.1 Sol Review：直接请求持久化 guard 对 crash、lease、retry、restore/delete 的闭环；模型发现 saved key 与目标绑定；边界是否遗漏，是否需要调整后实现。
