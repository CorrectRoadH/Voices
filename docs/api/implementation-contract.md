# 实现接口契约

本页细化 [架构](../architecture.md) 中已采用的 DTO 和 UI 集成行为，不改变持久化与资源所有权。

## HTTP 与鉴权

API 前缀 `/api/v1`，同源 Cookie 会话。GET /session 未登录返回 401；登录 POST /session body 为 `{identifier,password}`，identifier 为用户名或邮箱，含 @ 时按邮箱匹配。

登录和 GET /session 返回 `{authenticated:true,csrf_token,user,public_base_url,restore_mode}`。所有其他写请求发送 `X-CSRF-Token`。

创建录音、转写、人物和标签时发送随机 UUID `Idempotency-Key`；同键不同内容返回 409。

错误为 `{error:{code,message,details?,request_id}}`。UI 不展示 provider 原始响应。

列表为 `{items:[],next_cursor:null|string}`；分页参数 cursor、limit，最大100。时间为 RFC3339，时长与位置为毫秒。

写入 revision 必填；409 表示已被修改，刷新后再编辑，不能静默覆盖。

## DTO

完整字段、类型与可空约束以 [OpenAPI](openapi.json) 为准，前端从此生成 TypeScript 类型。

- Recording 保存录音元数据、媒体状态和当前激活版本。
- Transcription 保存服务商、模型、请求快照和处理状态；详情附带 speaker_labels。
- Segment 返回有效文本、原文、人工校正、可空时间与当前说话人身份。
- SpeakerLabel 保存录音内说话人标签和可空人物关联；Person 保存当前账号的人物档案。
- Job 返回阶段、状态和错误码；列表附带 operations，包含核对所需的操作 ID、远端 ID 和观察说明。
- Provider 与 Model 返回连接配置状态及模型语言、说话人和时间戳能力。
- Settings 只保存默认服务商、模型与语言偏好，不接受 API key；网页导入固定提交 auto_transcribe=true。

## 路由补充

GET /recordings 支持 q,from,to,person_id,state,cursor,limit。返回 Recording 列表，详情 GET /recordings/{id} 返回 Recording。

POST /recordings 使用 FormData；先 append metadata JSON，内容为 `{title?,recorded_at?,notes?,auto_transcribe,transcription_options?}`，再 append file。

上传成功返回 `{recording:Recording,existing:boolean}`。前端逐文件 XHR 显示上传进度，每文件独立幂等键。

PATCH /recordings/{id} 接受 `{revision,title?,recorded_at?,notes?}`。DELETE 返回202。音频路由 /recordings/{id}/audio。

POST /recordings/{id}/transcriptions body 为 TranscriptionOptions，可加 acknowledge_duplicate_risk；返回 `{transcription:Transcription,job:Job}`。

GET /recordings/{id}/transcriptions 返回版本列表。GET /transcriptions/{id} 返回详情及 speaker_labels。

POST /transcriptions/{id}/activate body 为 `{revision}`，返回更新的 Recording；cancel 返回202。首个成功版本自动激活，后续由用户选择。

GET /transcriptions/{id}/segments 返回 `{items,next_cursor,previous_cursor}`，支持 anchor_id 加载目标周围窗口。

GET /segments/{id} 返回 Segment。PATCH 接受 `{revision,edited_text?:string|null,start_ms?:number|null,end_ms?:number|null,assignment_mode?:inherit|label|unknown,assigned_label_id?:string|null}`。

POST /transcriptions/{id}/speaker-labels 接受 `{display_name,person_id?:string|null}`。PATCH /speaker-labels/{id} 接受 `{revision,display_name?,person_id?:string|null}`。

GET /people 支持 q,archived,cursor,limit；POST 接受 `{display_name,notes?}`；详情 GET /people/{id}；PATCH 接受 `{revision,display_name?,notes?,archived?:boolean}`。

人物录音使用 GET /recordings?person_id=...。GET /providers 返回 Provider 列表；GET/PATCH /settings 返回 Settings。

GET /jobs 支持 recording_id,state,cursor,limit；POST /jobs/{id}/retry body `{}`，仅恢复安全阶段；POST `/jobs/{id}/resolve` 接受 `{operation_id?,remote_id?,note}`。

导出 GET /transcriptions/{id}/export?format=txt|srt|json，Content-Disposition 下载；不含时间的SRT返回422。

## 前端

UI 为中文个人工作台，浅色默认，克制的中性色与一个强调色；适配移动端。使用实际 shadcn Base UI 源码组件和语义 token。

导航为录音库、人物、任务、设置。录音列表、拖入上传、录音详情、播放器、版本和句子编辑须走真实 API，无生产假数据。

登录后回到本站相对路径；路由支持 PUBLIC_BASE_URL 前缀，Vite 开发代理 /api 到 localhost:18080。

深链接 `/recordings/{r}/transcriptions/{t}?segment={s}`，打开时鉴权并加载指定版本及锚点，禁止自动改用当前激活版本。

复制 Markdown 使用当前人物名或标签名与有效文本；转义反斜杠、方括号和换行；音频有时间戳才 seek，不自动播放。

复制失败提供手动复制对话框。模型能力缺失不隐藏已有文本编辑和人物管理入口。

## Provider 实现边界

Go module 为 voices。接口以 internal/providers/types.go 为准；Soniox 与 AssemblyAI 构造函数为 NewSoniox(apiKey string) Adapter、NewAssemblyAI(apiKey string) Adapter。

测试可使用包内可注入 HTTP client/base URL；生产 URL 固定。不要导出任意 URL 配置作为生产接口。

Upload/Submit 每次只发一个创建操作；网络错误返回 uncertain。无数据库、任务循环和自动重试，均由主应用负责。

归一化保存标点与原文顺序；无时间/说话人保留 nil，不猜测。远端清理能力不足须报告证据，不能把 unsupported 当成功。

## 账号与权限

邮箱和密码用于登录，注册另填用户名（显示名称）。邮箱规范化后唯一，用户名可重复。首次注册创建管理员，事务锁保证并发唯一。公开接口为 `/auth/status`、`POST /users`、`POST /session`；其余接口要求会话。Session 返回 user 摘要。账号接口与角色约束见 [账号契约](../feature/accounts/README.md) 和 [具体方案](../research/account-isolation/README.md)。

业务资源归属来自会话，客户端不能指定 owner。所有资源 ID 路由先通过归属守卫；列表、搜索和幂等键按 owner 隔离。系统管理员访问他人业务内容仍返回 404。管理接口需要实时 admin 角色；角色修改和启停记录审计，不能移除最后一个有效管理员。

远端资源归属不能由 Web 账号自行声明。`POST /jobs/{id}/resolve` 可保存观察、确认本操作已有 ID；未知远端 ID 返回 403 `operator_reconciliation_required`，须使用本机运维命令核对并登记。
