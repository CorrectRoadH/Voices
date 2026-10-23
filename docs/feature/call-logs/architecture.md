# 统一外部调用记录架构

## 目标、现状与取舍

jobs/provider_operations 是 STT 执行与恢复的真源，transcription_insights 每次重建同一转写的生成状态；runtime_events 只保留异常。上述表都不能充当完整请求历史。新增 external_calls 作为外部操作尝试的持久化记录，永久保存。记录失败和缺失不能改变原任务安全判断；不以调用日志证明资源存在、清理完成或费用结算。

本方案扩展管理员跨账号可见的运维元数据边界，并首次确定调用记录持久模型，需要独立原生 Codex Review。费用价格、账单、完整 HTTP 抓包、内容管理权限及新的自动重试不在本次范围；原 STT 费用研究中的价格模型仍未采用。

调用粒度是一轮适配器操作尝试，不是应用 API 请求或 TCP 重传。一个 adapter 方法至多执行一个应用级 HTTP 操作；既有客户端仍不跟随重定向、不重试创建/生成请求。轮询每一轮单独记录，清理前查询与删除分别记录。适配器在发起网络请求前本地拒绝的尝试也有记录，并标为未发送。

## 表与字段

external_calls：

| 字段 | 类型与约束 | 含义 |
| --- | --- | --- |
| id | uuid PK | 一次尝试 ID，应用生成 |
| owner_id | uuid NOT NULL FK users(id) | 从录音/转写拥有者或管理请求当前账号取得；禁止请求体指定 |
| category | text NOT NULL CHECK stt/ai | 调用类别 |
| operation | text NOT NULL 固定枚举 | upload/submit/poll/fetch_result/delete_file/delete_transcription/generate_insights/list_models/test_model |
| provider | text NOT NULL 固定枚举 | soniox/assemblyai/openai_compatible |
| model | text NULL，最长 200 字符 | 转写快照或生成配置中的模型 ID；list_models 未选择模型为 NULL |
| recording_id、transcription_id、job_id、operation_id、generation | uuid NULL | 已验证的关联 ID 快照，无业务 FK，删除正文不删除元数据 |
| started_at | timestamptz NOT NULL DEFAULT clock_timestamp() | 调用尝试开始 |
| deadline_at | timestamptz NOT NULL | 最长执行期限加 30 秒写回余量 |
| finished_at | timestamptz NULL | 实际返回完成时刻，未完成不虚构 |
| duration_ms | bigint NULL CHECK >=0 | 单调时钟测量，未知不填 |
| state | text NOT NULL CHECK running/succeeded/failed/uncertain/interrupted | 请求结果；不代表转写任务结果 |
| request_started | boolean NULL | 已进入 HTTP client.Do/Transport 时 true；本地拒绝 false；无结束回执时未知 |
| http_status | smallint NULL CHECK 100..599 | 已观察响应状态 |
| audio_duration_ms | bigint NULL CHECK >=0 | STT 对应原始音频时长，不可跨多条请求直接累计为计费时长 |
| input_tokens、output_tokens、total_tokens | bigint NULL CHECK >=0 | 模型实际返回的独立用量字段；缺失保持 NULL，零可为真实值 |
| error_code、error_reason | text NULL，最大 64 字符 | 应用固定白名单，禁止原始错误字符串 |

owner_id 不允许为空及改归属（复用 immutable_owner trigger）；users 当前无删除账号 API，沿用 REFERENCES 默认限制。业务 ID 无 FK，但写入只能来自可信 SQL 查询或执行上下文，不能用外部输入认领。索引包括：

- `(started_at DESC,id DESC)` 与 `(owner_id,started_at DESC,id DESC)` 支持时间及账号排序。
- `(job_id,started_at DESC,id DESC) WHERE job_id IS NOT NULL` 支持任务筛选。
- `(transcription_id,started_at DESC,id DESC) WHERE transcription_id IS NOT NULL` 支持转写筛选。
- `(deadline_at) WHERE state='running'` 支持过期检查。

为 operation_id 非空创建 UNIQUE 索引（创建操作不会重复发送）；为 generation 非空创建 UNIQUE 索引（AI generation 至多一次 Generate）。provider_operations 的 operation_id 与 AI generation 不互用。

migration 只新建表和索引，不从历史任务回填请求。旧运行实例在升级前发出的请求不承诺被回溯捕获。回滚旧应用可保留该表；不改写旧持久化含义。关联记录删除不需补偿事务。

## 采集与模块边界

internal/outbound 提供请求上下文中的 Observation（网络已启动、状态、token、受控网络原因），只有 metadata，不持有 DB/录音/凭据。WithObservation 在每次应用操作创建独立实例；MarkStarted/MarkStatus/MarkUsage 等由 HTTP 边界调用，作用于当前 context。无观察者时保持现有客户端行为；SDK 不因观察者自动创建额外请求。

internal/providers/http.go 在 client.Do 前标记请求已启动，响应到达即标记状态，网络/读取失败只标记允许的分类。Soniox/AssemblyAI 继续返回现有 Error；相同的 Diagnostic 白名单用于落库。

internal/insights 的 boundedTransport 在 RoundTrip 前后记录网络事实；Generate 获得 response 后、内容验证前读取 SDK usage 字段的存在性（缺失与显式零区分），写入 Observation。生成内容仍只走原结果路径。ListModels 标记网络事实但不写虚假的 token 用量。insights.FailureReason 的受控输出校验原因（unknown_segment 等）写入调用原因。

internal/app/external_calls.go 拥有 start/finish、分类与查询、过期处理。启动写入失败则不调用外部服务。finish 使用 context.WithoutCancel 和独立 2 秒 deadline 尽力保存；失败只写结构化本地警告并使 DB 中仍在运行的记录最终显示 interrupted，绝不因此重试已完成请求。finish 不向业务调用返回记录错误，避免远端成功被重发。错误只通过明确白名单，unknown code 映射 internal_error。

### STT 创建

remoteCreate 的 prepared→sent 事务中同时插入 running 调用行，关联该 operation_id；原 fence、租约与事务仍拥有发送许可，事务失败不发请求。提交后在已有 step deadline 下 attach Observation 执行 Upload/Submit，拿到返回值立即 finish（记录远端适配器结果，不等待业务 registerResourceTx）。之后按原逻辑登记远端 ID 或 uncertain。

晚到响应可完成调用记录，但不绕过 job fence 发布业务结果；日志成功只说明适配器返回成功，登记失败仍由任务错误显示。事务提交回执不明时同样禁止发送；不能从调用行存在推断发送权限。

### STT 查询/结果/清理

Poll、FetchResult、清理前 Poll、DeleteResource 每轮调用前查询该 transcription 的 owner/provider/model/recording/duration 以及 job ID。插入独立行后执行原方法；查询失败或记录无法建立则不发请求，业务按原本的错误恢复。清理轮询 operation= poll、清理删除按资源 kind 区分 delete_file/delete_transcription。不记录未调用服务商的方法（如已知资源复用）。不修改现有清理排他锁、资源所有权及删除条件。

### AI

claimInsight 把 queued→running 和 generate_insights 调用行写入同一事务，work 携带 call ID。executeInsight 在独立 Observation 中执行 Generate、保存实际返回/错误/用量，再按既有租约保存正文；后一次生成创建新 generation 和新日志，不覆盖旧行。配置不匹配等本地失败标 request_started=false。adminLLMModels 在校验配置和权限后创建 list_models 行；adminLLMTest 在当前配置验证后创建 test_model 行，二者 owner 为操作者。已有恢复模式权限限制不变。

## 状态、恢复与保留

succeeded 表示该操作成功返回（包括轮询还在 processing），并非完整业务完成。failed 表示收到明确失败/本地拒绝/结果校验失败；STT Error.Code=uncertain 对应 uncertain。AI 生成若网络请求已经启动且没有完整成功/明确拒绝响应的传输错误，映射 uncertain；有响应的内容验证失败为 failed，仍保存已知用量。用户取消/超时仅表明本地终止，不能声称服务商未计费。

running 超过 deadline_at 后派生为 interrupted，HTTP 查询直接用 effective_state 表达，所以即使后台停了也不显示永远运行。后台每 10 秒最多更新 1000 条 expired 行，记录 error_code=interrupted，不捏造 finished_at/duration。真实晚到 finish 允许覆盖仍无 finished_at 的 interrupted 行，完成单个调用记录，不改变业务恢复状态。完成操作只按调用 ID 更新尚无 finished_at 的行，不 JOIN 当前业务对象，不以 UPSERT 重建不存在的记录。

Restore 在事务中将 running 行标 interrupted/error_reason=database_restore，不能自动重发；之后晚到结果仍只更新日志，不解除任务隔离。

查询不设历史时间下限，调用记录永久保存；后台仅标记中断，不删除调用记录。最长单次调用为 30 分钟，不需要以保留日志阻塞业务删除。启用前历史不回填；日志不构成财务账本。

## HTTP 与权限

GET /api/v1/calls：强制 owner_id=会话用户，忽略不得变成跨用户查询；如果传入 owner_id 或 account 查询参数直接 400。GET /api/v1/admin/calls：沿用 admin 前缀鉴权，每次请求检查当前管理员角色及 active 状态。

两端筛选约束：

- category、operation、provider、state 为枚举。model 为最长 200 字符精确匹配。
- job_id、recording_id、transcription_id、generation 为有效 UUID。
- from/to 为 RFC3339，from inclusive/to exclusive，from>=to 为 400。
- limit 默认 50、1..100。cursor 为严格 base64url {started_at,id}，按 started_at/id 倒序 keyset，最大 512 字符。

管理端额外支持 owner_id UUID 和 account（当前邮箱/用户名/显示名的字面不区分大小写子串，转义 %/_，最长 200）。未知筛选值报错，不静默放宽。

返回 {items,next_cursor,retention_days:null（无期限）}。items 包含上述公开记录字段（不返回内部 deadline），effective state 替换 running 过期状态；管理端附 actor:{id,email,display_name}|null，个人不展示额外用户数据。可返回 recording_available、can_open_recording（当前请求者拥有且未 deleting）；不返回录音标题、文件名、正文、模型输入输出或 remote_id/URL。调用 ID 与关联 ID 是诊断引用，不赋予任何业务读写权限。不存在跨账号任务详情、核对、重试或删除接口。

客户端只对本人仍存在资源提供录音或任务入口；管理员可对任意 job_id 筛选调用历史，不导航个人任务 API 来尝试越权。记录元数据不包含“HTTP 401 也泄漏原始内容”的例外。

## 界面与实现约束

管理导航新增“调用日志”→/admin/calls；“系统日志”继续提供管理审计与运行异常。个人 /jobs 用 view=calls 切换调用记录，原查询状态仍用于任务页；卡片的查看调用记录链接携带 job_id。共用 CallLogs 组件，admin prop 只改变 API 路径与账号筛选，服务端独立强制权限。日期用本地输入转换为 RFC3339，空范围省略。切换筛选清空旧游标/条目，失败不混入之前筛选；每页加载结果去重，刷新回第一页。详情为折叠元数据，长 ID 可换行，窄屏使用卡片。

## 验收与剩余风险

- 真实应用入口运行 STT 上传/提交/多次查询/结果读取/资源清理与 AI 生成/模型目录/测试模型，实际 fake HTTP 次数与日志逐条匹配。成功、HTTP 401、503、异常 JSON、输出校验失败均可见；错误原因无秘密。
- 崩溃窗口、DB 写入失败、租约丢失/晚到响应、Restore、生成再次执行、录音删除后的行永久保留用集成测试验证；调用记录不得造成额外创建请求。
- 服务端直接测试个人越权、管理员降级、非法筛选/游标、同时间戳分页，以及记录/API 中不存在原始 prompt/密钥/URL/音频标题。
- 新增中文自然语言 E2E 验证个人入口、管理员全站筛选、查看原因和用量、刷新/加载更多、窄屏。测试代理显式配置；被测 STT/LLM fake。
- vp run check、针对性浏览器入口、Concord 检查及 diff 核对。每轮查询均有一次短 DB 操作，长期积累的轮询记录可能较多；本版本不合并轮询或伪造请求数，后续可根据实际量添加分区。
