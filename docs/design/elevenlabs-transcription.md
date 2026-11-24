# ElevenLabs Scribe 文件转写

## 用户入口

管理员在服务器设置中保存独立的 ElevenLabs API Key，重启应用副本后，用户可在转写偏好、导入和重新转写中选择 ElevenLabs 的 Scribe v2（`scribe_v2`）。首次初始化服务器配置可从 `ELEVENLABS_API_KEY` 或其 `_FILE` 变量导入。既有实例沿用数据库配置优先级。读取接口仅返回 `elevenlabs_configured`，留空保留、显式清除、修订冲突和审计沿用[服务器设置](../feature/accounts/architecture/server-settings.md)。

## 请求和结果

服务端使用固定的 `https://api.elevenlabs.io` 和 `xi-api-key` 请求头，通过 multipart 向 `POST /v1/speech-to-text` 发送原始文件。模型支持自动检测及单语言，单语言使用 `language_code`。开启说话人区分和词级时间，关闭音效标记。文件必须小于 5,000,000,000 字节，同时遵守实例的上传限制。请求禁止跟随重定向。

将返回词序列按说话人和句界合并为可阅读的片段，保留原文中的空白、标点和无空格语言。时间以词的起止秒数换算为毫秒。服务商缺失时间或说话人时按[转写用例](../feature/transcription/use-case/transcribe.md)展示已有内容。

## 远端资源

一次文件提交可能计费，并创建可查询和删除的远端转写记录。发送前持久登记 submit 操作，收到 `transcription_id` 后登记 transcription 资源。已知 ID 的任务可以用 `GET /v1/speech-to-text/transcripts/{transcription_id}` 恢复结果。提交受理情况不明时进入原有人工核对路径，禁止自动重发。恢复仅核对该服务商实际存在的提交操作。

结果发布或取消后，后台按既有清理契约对已知 ID 执行 DELETE，成功或确认资源已不存在后更新清理状态。录音删除遵守同一规则。验收使用隔离的服务商 HTTP 边界，覆盖提交字段、可读结果、受理不明、已知 ID 恢复、清理失败重试和凭据脱敏。

[官方转写接口](https://elevenlabs.io/docs/api-reference/speech-to-text/convert) · [官方接口清单](https://api.elevenlabs.io/openapi.json)
