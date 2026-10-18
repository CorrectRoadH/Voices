---
format: concord.document/v1
id: stt-operations-cost
title: STT 后台记录、用量与估算费用
createdAt: 2026-10-18T03:30:38.807Z
kind: research
sources: []
---

# STT 后台记录、用量与估算费用

## 状态与范围

这是待独立评审的具体方案，后台与费用功能尚未实现。用户要求简化导入选择，并在服务器管理中查看 STT 调用记录及价格。个人导入与编辑流程修复可独立交付，不依赖本方案。

新增跨账号运维元数据读取和可长期核对的费用快照属于新的权限及持久化边界。

按项目规则需独立原生 Codex Review 后实施。前次账号系统的审查豁免不自动扩展到此方案。

## 前台流程

导入以文件列表、自动转写开关和提交按钮为主。优先使用个人已保存选项。

未指定时选择能力目录中第一个已配置服务商及其第一个模型，界面展示实际选择，默认自动检测语言、区分说话人。提供折叠的转写选项，保留有意调整模型和语言的能力。

自动检测时隐藏语言输入，不显示整串语言代码。

不自动启用外部付费转写。

现有明确费用确认继续生效，删去重复说明。全批成功后关闭弹窗并提示数量，部分失败保留队列和重试入口。请求键在同一文件的网络重试中不变，用户有意重新转写才创建新的请求和计费尝试。

## 服务器管理

新增“STT 调用”与“模型价格”。普通用户不能读取这些管理接口。管理员只看运维和费用元数据：账号 ID/当前邮箱、提交时间、服务商、模型、音频时长、执行状态、外部提交是否确认、失败次数、价格版本、预计费用、任务与调用 ID。

不返回文件名、录音标题、音频、转写文字、原始响应、凭据或他人的业务页面链接。管理员仍不能通过现有业务 API 读取他人录音。删除业务数据后，费用记录只保留无内容的运维快照。当前没有删除用户功能。

如未来增加，应单独决定留存与匿名化规则。

调用列表支持日期、账号、服务商、模型和状态筛选，按 created_at/id 倒序游标分页，默认 50、最大 100。列表上方汇总同一筛选范围内提交数、已完成音频时长、已完成预计费用、进行中预计费用和结果待确认数量。

未定价项独立计数，不算零元。不混加不同币种。

## 费用口径与来源

只有服务商账单或明确费用字段可称实际费用。首版只提供估算，不声明与账单完全相等、不处理充值或余额、不自动换算汇率。

2026-10-18 核对：Soniox 官网使用 token 计价，给出的文件转写等效参考约为 0.10 USD/小时。

输入音频 token、输入文字 token 和输出文字 token 分别计价。因此用音频时长乘小时参考价只能称时长估算，不能当作实际账单。来源：[Soniox pricing](https://soniox.com/pricing)。AssemblyAI 按模型与附加能力提供价格，区分说话人等附加成本须按具体模型配置。

来源：[AssemblyAI pricing](https://www.assemblyai.com/pricing/)。

首版管理员录入 USD 每音频小时参考价及说话人区分的每小时附加参考价，注明来源与核对日期。

可采用合同参考价。未知或不适用模型保持未定价。UI 明示“按音频时长估算，实际账单以服务商为准”。同一次提交的参考价不可被后续改价重算。金额使用整数 USD 微元，不用浮点。

每条估算为 ceil(duration_ms * total_rate_microusd_per_hour / 3600000)，按条四舍五入到美分仅在展示层进行。聚合先加微元再显示，避免先逐条显示取整造成误差。

## 持久化建议

新增迁移，不清库，不更改既有业务与任务所有权。

- `stt_price_versions`：id UUID PK。

provider TEXT、model TEXT 非空。

currency TEXT CHECK='USD'。

hourly_rate_microusd BIGINT 与 diarization_hourly_rate_microusd BIGINT 非空且 >=0。

basis TEXT CHECK='duration_estimate'。

source TEXT、verified_on DATE 非空。

created_by UUID FK users。

created_at TIMESTAMPTZ。价格版本只追加不可改写。

索引 (provider,model,created_at DESC,id DESC)。管理员保存新价使用自身幂等键，审计同事务写入。
- `stt_calls`：id UUID PK。

owner_id UUID NOT NULL FK users。

operation_id UUID UNIQUE NULL FK provider_operations ON DELETE SET NULL。

job_id、transcription_id UUID NULL，同 owner 复合外键且业务删除时只清空资源 ID。

provider/model TEXT 非空。

duration_ms BIGINT 非空且 >=0。

diarization BOOLEAN。

price_version_id UUID NULL FK stt_price_versions。

rate_microusd_per_hour BIGINT NULL。

estimated_cost_microusd BIGINT NULL。

submission_state TEXT 为 prepared/sent/known/uncertain/confirmed_absent。

result_state TEXT 为 pending/running/succeeded/failed/cancelled。

created_at/updated_at TIMESTAMPTZ 非空。检查价格版本、单价与估算金额同时为空或同时非空。
- 业务删除后 operation_id 置空，但记录自己的 id 及快照保留。

不在记录中保存内容。使用 (created_at DESC,id DESC)、(owner_id,created_at DESC,id DESC)、(provider,model,created_at DESC,id DESC) 索引。独立记录主键避免业务删除后重复归档。

在真实远端 submit 的 prepared 意图事务中创建一条 stt_calls，锁定当时最新适用价格快照。

使用 operation_id 唯一性防重。从 prepared 到 sent、已确认 remote ID、uncertain 等更新与现有意图状态同事务提交。查询远端结果只更新本条结果，不创建新调用。

租约恢复复用既有 submit 记录。明确重转形成新 submit 意图及新调用。成功落库和取消/失败流程同步结果状态。

未知远端结果保持待确认，不能当作零费用或成功。

存量 submit 意图可导入记录，但 price_version_id 与估算费用保持 NULL，并标记历史未定价。

不使用今天价格伪造历史单价。上传操作可在任务技术详情查看，不在 STT 费用汇总中重复记一次转写。

## API 与权限

- GET `/api/v1/admin/stt/calls`：上述受限字段、过滤及游标分页。

不接受任意业务字段展开。
- GET `/api/v1/admin/stt/summary`：与列表完全相同筛选语义，按币种、确认程度分别统计。
- GET `/api/v1/admin/stt/prices`：最新价格及显式历史版本分页。
- POST `/api/v1/admin/stt/prices`：创建价格版本，验证 provider/model 位于能力目录、整数金额、有效来源和日期。

需管理员会话、CSRF、幂等键和审计。

恢复模式拒绝写入。

管理端不得复用普通业务 ID 授权的旁路。权限在每次请求校验最新角色。

普通用户返回 403，未登录返回 401。仍不提供后台重新提交 STT 的快捷操作，避免一次运维点击重复计费。

## 取舍与待审问题

选择逐 submit 意图快照，避免同一任务的轮询、进程重启或本地重试被重复计费。按小时估算适合首版展示，但不冒充 token 用量或实际支付。费用留存独立于业务删除，是本次需要审查的核心生命周期变更。

管理员跨用户看到调用元数据，是本次需要审查的权限变更。

独立评审重点：复合外键局部 SET NULL 的可行性、所有远端意图/结果终态是否原子同步、存量迁移在运行中任务上的幂等性、并发改价时快照的确定性、列表和汇总不会泄露内容、删除录音不抹去待确认付费记录。

## 验收

真实 PostgreSQL 验证重复提交键和重复 worker 恢复只产生一条费用记录，显式重转产生两条。

并发改价不会改变旧快照。

结果待确认不混入已完成汇总。

无价格显示未定价。

用户删除录音后费用记录与状态可核对且无内容泄露。验证普通用户和降级管理员被拒绝、金额极小/较大值不会浮点丢精度、分页与汇总筛选一致。浏览器验证前台短流程、部分失败重试、成功关闭，以及管理员筛选调用与保存新参考价。真实付费接口不作为默认自动化测试边界。
