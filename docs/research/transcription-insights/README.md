---
format: concord.document/v1
id: transcription-insights
title: LLM 录音摘要与目录设计
createdAt: 2026-10-18T14:12:46.135Z
kind: research
sources: []
---

# LLM 录音摘要与目录

## 选型与范围

采用官方 `github.com/openai/openai-go/v3`，版本固定在 go.mod。管理员的 llm_base_url/model/api_key 用于兼容 OpenAI 的 Chat Completions。[SDK](https://github.com/openai/openai-go)提供地址、超时及重试控制。

Eino 提供图编排，LangChainGo 提供链与检索；单次结构化生成不引入这些框架。地址和模型必填，本地服务可留空密钥。只用进程启动生效配置，不继承 SDK 环境，不回退地址或模型。

用户手动为成功转写版本生成摘要与主题目录。界面说明发送转写文本及可能收费，重新生成替换旧结果。不自动生成、不上传音频、不引入聊天或 RAG。结果标为 AI 辅助内容，须核对原文。

章节必须引用真实 segment UUID。点击以现有 anchor_id 分页加载正文，不受已加载页限制；读取当前片段时间，只有有效时间才定位播放器，不自动播放。空时间或零时长仅定位正文并解释原因。过期结果不会使用旧时间定位音频。

## 持久化模型

迁移010新增 transcription_insights，一行对应一个转写版本。无旧数据迁移，旧程序可忽略该表回滚。未标可空的字段均 NOT NULL：

| 字段 | 类型与含义 |
| --- | --- |
| transcription_id | UUID PK，FK transcriptions，ON DELETE CASCADE |
| generation | UUID，每次显式生成更换 |
| state | text，CHECK queued/running/succeeded/failed |
| source_hash | text，有序片段 id/start_ms/end_ms/text 的 JSON SHA256 |
| input_json | nullable jsonb，生成期间的文本快照 |
| result_json | nullable jsonb，summary 与 chapters |
| model | text，入队模型名称 |
| error_code | nullable text，受控错误码 |
| created_at / updated_at | timestamptz，数据库 clock_timestamp 默认值 |
| lease_until | nullable timestamptz |

索引 `(state,created_at)` 仅覆盖 queued/running。result 的章节保存 segment_id/title/start_ms；start_ms 可空，由服务端从快照推导，不接受模型时间。完成或失败清空 input_json，录音删除级联回收。

hash 不含人物或说话人名称；改人物不使结果失效，改文本或时间则失效。旧结果仍可读并标过期。baseURL/key 不入任务表。

## HTTP 契约

### 读取

`GET /api/v1/transcriptions/{id}/insights` 返回 configured 和可空 insight。configured 表示 active 地址及模型齐全，不代表服务已验证。沿用转写所有权，管理员没有越权例外；删除中录音不可读。

insight 包含 generation、state、model、created_at、updated_at、error_code、stale、summary、chapters。没有结果时 summary 为空字符串、chapters为空数组；stale 比较当前文本快照 hash。

### 生成

`POST` 同路径接收空JSON对象，需要现有 Idempotency-Key，返回202及相同响应形状。以 recording 行锁与片段编辑、删除串行化；转写须 succeeded，restore mode 禁止提交。

空正文返回422 empty_transcript。超过5000片段或200000 UTF-8字节返回422 transcript_too_large，不静默截断。queued/running 时不同key返回409 generation_in_progress。显式新请求覆盖旧结果，失败可再次手动生成。

幂等 scope 为 insights:<transcription UUID>，固定请求 hash 为 v1，resource_id 存 generation。文本变化不改变相同 key 的含义；重复key返回对应当前代次，若已被后续生成替换则409，不再收费。

删除录音在删除转写前按 scope 清理全部对应幂等键。创建回执失败时客户端保留同key重试，成功后才为下一次显式生成换key。

## 执行和资源生命周期

App.Run 拥有调度与执行 goroutine，退出用 wait group 等待。每秒最多领取一个，事务 advisory lock 771940005 保证全实例最多一个有效 running；771940004 留给现有维护。

领取锁 recording 行，要求非 deleting、转写 succeeded。账号 disabled 时 queued 变 failed/account_disabled。领取后释放事务，再调用服务。没有自动重试。

queued 可跨普通重启继续执行。running 固定180秒 lease，HTTP最多120秒，无心跳；过期仅变 failed/interrupted，清空输入，不重新调用。关闭服务取消HTTP，使用独立2秒预算持久失败。

最终写入重新锁 recording，generation+running+有效lease 作 fence。已删除的录音不重建结果，旧执行者不覆盖新代次。生成期间允许修改正文，完成后 GET 会标 stale。

Restore 正式入口在既有恢复事务中将全部 queued/running 变 failed/interrupted，清空输入与lease，保留成功结果。恢复模式不领取；退出后用户须显式再生成，不能重放快照中的排队任务。

失败或中断提示上次可能已计费，再生成会再次调用。worker 模型须与入队 model 相同，否则 configuration_changed。地址或凭据切换前须完成队列；队列执行使用 worker 当时生效配置。

## SDK 与输出验证

使用 `NewChatCompletionService`，服务构造不读取环境；显式设置 BaseURL、APIKey、空 Organization/Project。隔离全部 OPENAI_*，包括 CUSTOM_HEADERS。关闭重试，禁止重定向，响应body最多1MiB，max_completion_tokens=4096。

请求使用 JSON object response format。服务不支持参数时返回失败，不自动降级再请求。system 要求转写是数据而非指令，摘要语言与原文一致；用户内容以 JSON 发送。不启用 tools，不执行输出，不渲染原始HTML。

严格解码一个JSON对象，无额外字段。summary为1..4000字，chapters为1..30项，title为1..120字。锚点必须存在于输入，严格按输入位置递增；首章须引用首片段。拒绝截断、拒答、未知锚点、重复或逆序锚点。

错误码只允许 llm_unavailable、llm_rejected、invalid_response、interrupted、configuration_changed、account_disabled。不保存、返回或记录远端错误正文、文本或密钥。

## 独立审查与验收

原生 Codex / GPT-6.1 Sol Review 及限定范围复核通过。两项阻塞已收敛：Restore 隔离 queued/running；时间可空，跳转用当前片段有效时间。幂等键回收、SDK环境隔离和输出上限也已明确。

真实 PostgreSQL+SDK 对接 fake HTTP 验证权限、CSRF、restore、配置、输入限制、幂等、并发领取、跨实例读取和stale。覆盖未知/乱序锚点、响应超限、错误脱敏、无重试、lease不重放、shutdown和删除 fence。

注入冲突 OPENAI_* 检查请求地址与头。模拟 queued 快照在恢复退出后无新增调用。验证首片段无时间、零时长、编辑后修改或清空时间。浏览器覆盖生成、轮询、失败、再生成、未加载章节、深色及窄屏。

运行 Go tests/vet、前端 tests/build、OpenAPI类型生成、Concord检查。设计通过不代替实现验收，不调用真实付费模型。
