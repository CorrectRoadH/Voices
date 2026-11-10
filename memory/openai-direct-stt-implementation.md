# OpenAI 直接转写实现与验收

2026-11-09，依据 docs/design/openai-transcription.md 与用户指定的 022 迁移，实现独立 OpenAI STT 配置、DirectAdapter、直接执行及恢复隔离。首发保持 gpt-4o-transcribe-diarize；官方文档声明其计划于 2027-02-26 停用，没有擅自更换模型。未调用真实付费服务、未部署。

## 设计收敛与审查

主 agent 编写具体修订，Herdr 原生 Codex / GPT-6.1 Sol Review 发现并在限定复核中关闭三项 P1：恢复快照的 NULL 许可不能经 retry 重放；仅有 prepare 的自动转写意图须持久隔离；发送后 failed/cancelled 任务的新版本仍须收费确认。

采用独立恢复事实 error_code=direct_request_interrupted；同一 job 的发送许可一旦消耗不释放。Restore 为未消费的 OpenAI 自动导入创建同 auto dedupe 的失败版本，prepare 仍能完成音频；非成功直接任务全隔离，成功保留，不生成虚假远端操作。统一 duplicate_risk SQL 同时服务 Job API 与新版本授权。许可与调用日志同一 fenced 事务，只有明确提交成功的调用栈能发送；日志 direct_* 固定白名单映射 failed。

Review：openai-stt-review，parent=t1bv，terminal=t1bx，模型 gpt-6.1-sol/high，角色只读 Review，写入范围仅 /tmp/voices-openai-stt-review.md。初始任务通过原生 Codex argv 传入并核实已启动。两轮完成报告均已读取；终端已 kill/rm，无 pane/tab。完整门禁终端 openai-stt-gate=t1c3，parent=t1bv，退出 0 后已 rm。

## 验证

使用本轮独立 PostgreSQL 18 集群 /tmp/voices-openai-pg，端口 55594。默认 PATH 缺 C 编译器且 Nix daemon 不可达，显式使用现有 gcc-wrapper-15.3.0 的 CC/CXX；ffmpeg 使用现有 Nix store 路径。没有更改用户系统配置。

- `./scripts/go.sh test ./internal/providers/...` 通过。HTTP fake 验证 multipart、显式凭据与环境隔离、格式/大小/语言限制、真实说话人与毫秒时间转换、非法响应、取消、reader 所有权、429/5xx/307/308 不重试或重定向及错误脱敏。
- `./scripts/go.sh test ./... -count=1` 在隔离数据库通过。新增真实 App/HTTP/worker 验证成功入库、无远端资源、调用日志、限流终止、发送许可事务回滚、响应后结果落库失败、lease 接管/晚到发布 fence、取消和删除、reader 释放、恢复 queued/running/failed/cancelled、成功保留、恢复前 prepare 自动意图、retry/reconcile 拒绝、新版本风险确认与幂等。原 async 与 voiceprint 回归通过；测试 fake 显式嵌入 AsyncAdapter。
- `vp -C web run check` 与构建通过；保留既有 lint warnings 和 bundle size 提示。
- 根目录 `vp run check` 9/9 成功，包含全 Go、33 前端测试、10 worker 测试、4 release 测试、Go vet 与构建。日志 /tmp/voices-openai-full-gate.log。
- `VOICES_BROWSER_TEST=1 E2E_CHROMIUM_EXECUTABLE_PATH=/run/current-system/sw/bin/chromium ./scripts/go.sh test ./internal/app -run '^TestOpenAISTTBrowser$' -count=1 -v` 通过。真实 Go/PostgreSQL/Chromium 验证配置自动保存与脱敏、OpenAI 模型选择、重新转写风险提示与创建独立版本、375px 无溢出。仅模拟 STT HTTP；没有配置测试 LLM。截图位于 web/.e2e/openai-stt/，桌面和手机深色实际查看。浏览器控制台有既有内嵌字体 CSP 拒绝，不扩大本任务修复范围。
- `concord check --json` 通过，complete=true、findings=[]。`concord trace gaps --json` 因 HawdbUnavailable（Native artifact does not support asynchronous cache ownership）失败，不宣称关系无缺口；未清缓存、停止或重启用户 Concord 服务。

## 边界

没有验证真实服务商准确率、账号模型可用性、真实计费或生产环境。崩溃发生在许可提交与网络发送之间会保守失败；这是至多一次尝试，不是恰好一次收费。未知 commit 的分支通过事务返回错误不发请求，未注入 PostgreSQL 提交应答丢失。30 分钟实际等待未执行，取消/子 context 通过 HTTP 边界验证。

Nowledge 检索 query=Voices OpenAI direct transcription review，CLI 返回既有 Voices/Concord 背景，没有替代本轮源码核对；当前严格 default Space 无可核实图形会话权限，未自动展示记忆图。

最终使用 feat/openai-direct-stt 功能分支，避免 main push 触发部署。临时 PostgreSQL 与本轮测试终端在交付前回收；保留测试日志和截图作为证据，无新增 worktree/pane/tab。
