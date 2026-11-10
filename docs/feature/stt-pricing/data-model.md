# STT 估算费用数据模型

## 记录与所有权

迁移 023 新建 `stt_price_versions` 与 `stt_calls`，不清库，不改变业务所有权。
`external_calls` 继续记录每次适配器尝试，不参与费用汇总或恢复决策。

价格版本使用 UUID 主键，记录 provider、model、currency=USD、basis=duration_estimate。
基础价和说话人区分附加价为非负 bigint 微元，每小时合计不超过 bigint 上限。
source 为非空来源，verified_on 为核对日期，created_by 外键引用 users。
created_at 由数据库生成；版本只追加，拒绝 UPDATE/DELETE。
按 `(provider,model,created_at DESC,id DESC)` 建索引。

费用调用使用独立 UUID 主键，owner_id 非空且不可变，引用 users。
operation_id 唯一可空；operation_id、job_id、transcription_id 使用同 owner 复合外键。
三个业务关联删除均局部 SET NULL，只清对应 ID，不清 owner，也不删除费用行。
provider、model、duration_ms、diarization 是快照，不保存任何内容。

price_version_id、rate_microusd_per_hour、estimated_cost_microusd 必须同时为空或同时非空。
价格版本、总单价、估算金额、币种、basis、时长、服务商、模型、origin、创建时间后续不可改写。
created_at/updated_at 非空，金额与时长非负。

origin 分为 submission、historical、restore_observation。
历史导入和恢复观察禁止定价，不用今天价格伪造历史价格。
恢复观察的创建时间只表示本地观察时刻，不声称真实发送时刻。

submission_state 为 prepared/sent/known/uncertain/confirmed_absent。
result_state 为 pending/running/succeeded/failed/cancelled。
job_attempt 为当前任务 attempt 的快照，重试/核对可能归零，不称为累计失败数。

索引包含 `(created_at DESC,id DESC)`、`(owner_id,created_at DESC,id DESC)`、
`(provider,model,created_at DESC,id DESC)`，以及 job_id、transcription_id 的非空索引。

## 创建、状态与恢复

provider_operations 的 submit INSERT 触发器与真实 prepared 意图同事务建立快照。
单次 SELECT 同时读取价格版本与两项费率，选取查询当时已提交且可见的最新版本。
排序使用 created_at DESC,id DESC，同时间以 UUID 决定顺序。
未提交的新价格不可见。prepared 复用不创建新行、不更换快照。

按 diarization 选用基础价或基础价加附加价。
估算使用 `div(duration_ms::numeric * rate::numeric + 3599999,3600000)::bigint`。
这是非负整数 ceil 的精确形式，避免 numeric 除法先舍入导致少算微元。
最终超 bigint 时整个 prepared 事务失败，尚未发出远端请求。

operation UPDATE 同事务同步提交状态；jobs UPDATE 同事务同步结果和任务 attempt。
confirmed_absent 的优先级高于 job 的后续结果，拒绝的旧意图不会随新提交变成成功。
其它 job 终态按原值映射，running 映射 running，其余映射 pending。

录音处于 deleting 时，已结束费用结果和任务 attempt 保持原值；未结束任务才转 cancelled。
正常人工重试仍允许 failed→pending→succeeded，不能一概冻结失败结果。

迁移事务导入全部既有 submit 为 historical，费用为空，包含尚未发送的 prepared。
迁移后恢复合成的 uncertain submit 创建 restore_observation 行，费用为空。
核实远端 ID 后更新该行，重复 Restore 复用现有意图，不新增费用记录或远端请求。
恢复观察不计新提交数量，独立计数并进入待确认/未定价数量。

## 汇总谓词

| 指标 | 条件 |
| --- | --- |
| submitted_count | origin 不是 restore_observation，包含真实 prepared 意图及历史意图 |
| restored_count | origin 为 restore_observation |
| completed_duration_ms | known 且 succeeded，包括未定价时长 |
| completed_estimated_cost_microusd | known 且 succeeded，累加非空估价 |
| pending_estimated_cost_microusd | known 且 pending/running，累加非空估价 |
| uncertain_count | sent 或 uncertain，与结果状态独立 |
| unpriced_count | price_version_id 为空 |

返回 USD 总计与按 submission_state 分组的相同指标。
未定价数须与金额一起解释；金额为零不表示未定价调用免费。
prepared 不计进行中费用，confirmed_absent 不计完成或进行中；失败和取消的条目仍保留估价。
聚合使用 numeric，不转 bigint，金额及汇总数值公开为十进制字符串。

## 事务与审计

价格创建复用 owner+scope+key 幂等锁，scope 为 stt-price。
规范化来源后计算请求 hash，同键异参 409，同参返回原版本。
价格、幂等结果与 stt_price_created 审计同事务提交。
审计仅含 price_version_id/provider/model，不回传自由来源文本或业务内容。
事务内 lockAdmin 重新验证角色并与账号管理串行。

只通过 admin 前缀接口读取安全白名单字段，不返回标题、文件名、正文、音频、远端 ID 或原始错误。
权限每请求查当前角色；业务 authorizeResource 保持原有隔离。
