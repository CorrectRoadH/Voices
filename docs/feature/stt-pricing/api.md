# STT 费用管理接口

所有路径以前缀 `/api/v1` 开始，要求管理员会话。匿名 401，普通用户或降级管理员 403。
写入验证 CSRF；恢复模式拒绝写入。接口不提供重新提交 STT 的动作。

## 调用与汇总

GET `/admin/stt/calls` 返回 `{items,next_cursor}`。
按 created_at/id 倒序游标分页，limit 默认 50，最大 100，最小 1。
cursor 为严格 base64url JSON `{created_at,id}`，最大 512 字符，时间和 UUID 均须有效。

筛选支持 from/to（RFC3339，含起不含止）、owner_id UUID、provider、model 精确匹配、state 与 submission_state。
provider 仅 soniox/assemblyai。state 为 pending/running/succeeded/failed/cancelled。
submission_state 为 prepared/sent/known/uncertain/confirmed_absent。
未知参数、重复参数、非法日期/范围/枚举/游标均 400。

调用返回费用数据模型中的公开快照、账号 ID 与当前邮箱、操作/任务/转写 ID、创建和更新时间。
duration_ms 与金额为十进制字符串，缺少价格的相关金额为 null。
job_attempt 为当前任务重试计数，可能因人工重试归零。
origin 区分真实提交、历史导入与恢复观察，不伪造恢复任务的真实提交时刻。

GET `/admin/stt/summary` 使用完全相同筛选，校验但忽略 cursor/limit，不把列表分页限制用于汇总。
返回 currency=USD、totals 和 by_submission_state 数组。
每组含 submission_state 与 stats。字段及完整统计谓词见[数据模型](data-model.md#汇总谓词)。
所有汇总数值为字符串，空集数量/金额为 "0"，分组为空数组。

## 价格

GET `/admin/stt/prices` 默认读取每 provider/model 的最新版本，history=true 读取全部版本。
支持 provider/model/limit/cursor，分页规则同调用接口；history 只接受 true/false。

POST `/admin/stt/prices` 为退役拒绝入口。保留认证、管理员、CSRF 与恢复模式校验；通过这些校验的请求固定返回 403，code 为 manual_pricing_disabled。不解析请求体、不读取或写入幂等记录、不写价格或审计。无键、非法输入、并发请求和旧成功幂等键重放均不能创建价格。恢复模式仍可先行返回 409。

不提供 PATCH、PUT 或 DELETE 价格接口。只读价格返回 id、provider、model、currency、basis、两项小时费率、source、verified_on、created_by、created_at，金额为十进制字符串。历史版本不可修改或删除。
