# 发布与更新服务设计

## 目标与边界

复用 OpenTickly 的 GitHub Releases、Cloudflare Worker、站内版本与公告机制。GitHub Release 是发布说明唯一来源。

不新增官网或自动升级。实例统计与持久安装身份按 [统计与部署方案](telemetry.md) 提供，默认开启（UPDATE_TELEMETRY=false 可关闭）。现有录音与转写服务不依赖更新服务的可用性。

## 发布与 CI

PR 和 main push 执行 Go vet、前端与 Worker 静态检查、API 生成一致性及 CI 脚本检查。Nightly 和发布门槛执行 Go test/vet、独立 PostgreSQL 集成测试、前端 typecheck/test/build、e2e 真实应用浏览器验收、workerd 运行时验收及双架构 Docker 构建验证。

Worker 独立执行 check/test 和 cf build。依赖使用锁文件，Docker 构建检查不推送镜像。

正式 tag 为 `vX.Y.Z`，版本分量不超过 4294967295。CI 通过后构建 Linux amd64/arm64 镜像，发布到 Docker Hub。镜像成功后从提交生成 GitHub Release 正文。

所有 job 使用触发 tag 的 SHA，tag 不得重写。应用 `main.version` 注入同一 tag。容器保留 ffmpeg、非 root、healthcheck，无应用数据卷。

全局 release concurrency 串行。镜像发布前读取 GitHub 全部分页正式 Releases，拒绝低于或等于已发布最大版本的 tag。

同时读取 Docker Hub latest 的版本标签，拒绝降级。只有明确不存在的 package 才允许首次发布；认证或网络失败中止。同 tag 镜像成功而 Release 失败可重跑。

CI 验收使用只读权限，Nightly 的报告 job 单独获取 issues 写入权限。镜像和 Release job 分别获取 Docker Hub secrets/contents 写入权限。Worker 部署限于 main 的相关文件变更或手动触发。两种入口均执行配置校验、静态检查和 Worker 单测，手动入口另跑 workerd 验收。Cloudflare token 限定目标账户与 Worker。

本地实现和测试不授权实际 push、tag、发布或部署。镜像默认前端路径为 `/`；子路径继续使用 PUBLIC_BASE_URL 构建参数从源码构建。

## Worker 契约

`update-worker/` 使用独立 TypeScript、cf、Vite+ package/lockfile，不改变现有 workspace。公开只读 GET /，其他路径 404，非 GET/OPTIONS 方法 405。

Manifest 字段：

- schemaVersion：固定 1。
- latestVersion：稳定三段版本或 null，不带 v。
- releaseUrl、releasedAt：HTTPS 链接和 UTC 时间，未知版本时均为 null。
- releaseNotes：发布正文；未知版本为空字符串。
- announcements：有效公告数组。

不使用 cookie。GET 可选统计参数按 [统计与部署方案](telemetry.md) 验证，统计写入不影响 manifest。允许跨域读取。

GITHUB_REPO 为部署配置 CorrectRoadH/Voices，GITHUB_TOKEN 为可选服务端 secret。GitHub 各页共用 4 秒期限，不跟随重定向。Go 客户端的 5 秒 HTTP 期限还要覆盖 Worker 处理和响应传输。

每页100条，最多10页；仍有下一页则返回未知版本，不从不完整集合推断最大版本。过滤 draft、prerelease 和非法 tag，按数值取最大稳定版本。

GitHub 上游 HTTP 200 响应通过 Cloudflare fetch 缓存5分钟，重定向和错误响应不缓存。缓存按公开上游 URL 复用，不包含客户端统计参数。Cloudflare Cache API 另缓存成功版本快照5分钟，缓存故障不影响上游成功结果。公告每次请求重新过滤，HTTP 响应 no-store。GitHub 失败返回 null 版本和有效公告，HTTP 200。

公告来自 `content/announcements.json`，随 Worker 部署。字段 id、title、body、severity、publishedAt、expiresAt、link 必须完整；后两项可为 null。

severity 为 info/warning/critical；时间使用 UTC RFC3339。ID 唯一、过期晚于发布、链接仅 HTTPS。过滤未来及已过期公告，按发布时间降序。

公告包最多20条和64 KiB JSON。id/title/body 分别最多100/200/4000 UTF-16 code units。发布正文超过32000 code units时截断并明确提示，完整内容通过发布链接访问。

最终响应最多256 KiB。正文仅作纯文本展示，不执行 HTML。没有公告时使用空数组，不发布虚构内容。

## 更新 API 监控

更新 Worker 是自营专用服务，源码固定 `voices-update` project 的公开 DSN，组件固定为 `update`。仅现有 Vite production 构建模式初始化，环境名默认为 `production`，不要求额外配置；开发/测试构建以及显式 development/test/preview 环境关闭。部署提供 `SENTRY_RELEASE=update@<git-sha>`。录音桌面、本地服务和供他人部署的应用不接入；不固定私密上传 token。测试仅在显式拦截的 transport 边界观察投递，不访问线上 ingestion。

官方 Cloudflare SDK 按请求隔离 scope，单 isolate 复用客户端，使用 execution context 的 `waitUntil` 限时排空。根请求默认采样 0.01，保留合法父级采样决定；错误不抽样。使用 stream span lifecycle；禁止向 GitHub 或其它出站服务传播 trace headers，不安装第二套 OTel provider。上游失败继续返回未知版本及有效公告，并捕获异常；监控发送失败不改变更新响应。

错误事件保留实际异常类型、消息、原因链、堆栈及结构化业务详情。路由模板、HTTP 方法和响应状态码记录为 `route`、`http.method`、`http.status_code`；请求 URL 保留路径与非凭据 query。过滤凭据相关请求头、敏感 query 与结构化字段值，以及字符串中的 Bearer、API key、JWT、URL userinfo 和 Sentry DSN 公钥。SDK 默认个人数据采集保持关闭，不主动附加请求或响应正文、栈局部变量或源码上下文。4xx 和客户端中止不生成错误事件，5xx 与未处理异常上报；上游失败的降级异常仍上报并标记更新端点实际返回的 200。

保留经校验的 sourcemap debug ID、静态代码路径、debug images、代码栈位置和 trace 标识。根操作名固定为 `update.request`；实际 Cache API 读取、GitHub release 拉取（含分页/JSON）、响应组装、已验证的 Analytics Engine 写入分别为 `update.cache.read`、`update.upstream.fetch`、`update.response`、`update.analytics`。固定 operation 注册表同时驱动埋点和发送过滤，保留固定 outcome；未知名称回退 `update.request`。

阶段失败/取消在原有 catch 之前标记并抛回原错误，原有降级行为不变；analytics span 在原 `waitUntil` 回调内执行，根请求及响应 body 生命周期由 SDK 维护，响应组装 span 不代表传输完成。缓存写入没有已批准的独立 operation，不新增名称。Worker 无受支持的 CPU profiler，不增加 profile 依赖、manifest 或开启环境变量，拒绝 profile/profile_chunk。

环境、release 与组件来自配置。span 删除 links、动态路径、自由文本及未知属性。

入站 trace/span ID 只接受非零合法十六进制及可选 0/1 采样；丢弃外来 baggage，SDK 继续维护请求隔离与父采样，业务 handler 接收原始 Request。无 baggage 的 span v2 DSC 从同一 span ID 与本地配置修复，不借用其它请求。

最终 transport.send 在所有 envelope listeners 之后再次重建合法 error/span v2 与 typed attributes，并保留官方 transport 的缓冲、限时排空和 rate-limit 行为；不能通过直接 sendEnvelope 绕过清洗。`beforeEnvelope` 重建 header 与动态采样上下文，保留有效 trace ID、固定操作名和本地公开配置。删除外来 transaction、envelope header 中任意嵌套 metadata 和未知 payload 类别；每种已批准 item 独立按真实协议重建。不得新增公开异常测试端点。

验收用真实 SDK transport 核对错误详情和请求标签、嵌套 extra/context/breadcrumb 中的凭据过滤及根/子 span；在真实 workerd 中核对开发/测试零投递、错误与 span 排空、合法父 trace、出站无传播和发送失败隔离。生产事件回读与 sourcemap 上传由部署阶段另行授权验收。

Sourcemap 构建始终注入 debug ID；没有 `SENTRY_AUTH_TOKEN` 不上传。production 构建显式提供 token 时，要求同一 `SENTRY_RELEASE=update@<完整git-sha>`，上传至 `instaai/voices-update` 后删除输出 `.map`。token 不写入代码或产物。真实错误 event 必须保有对应 debug images；本地构建通过不代表远端上传或生产符号化验收完成。

### 固定日志与请求指标

顶层 update.request 在原 handler 完成的 finally 记录一次 app.operation.count（counter=1）与 app.operation.duration（distribution，millisecond）。成功、错误、取消、拒绝使用固定 outcome；SDK 接管的实际请求全量计数；OPTIONS/HEAD 沿其既有旁路，不新造业务操作，不依赖 trace 采样，子阶段不重复计数。没有实际 scheduled handler，不造 scheduler 指标。

实际上游与 analytics 捕获降级处只发固定 operation.degraded/warn；未捕获的顶层错误为 operation.failed/error。成功不重复发 info，Worker 每请求不冒充 service.started/stopped。现有 console/logger 不自动转发；日志只允许有限 operation/outcome、状态、耗时和安全配置/关联 ID。

早期 beforeSendLog/beforeSendMetric 清洗后，最终 transport 再次重建 typed attributes，防止 SDK 回填 scope 身份或任意属性。log 与 trace_metric 均使用数字 version=2、真实 item_count 和各自 content_type；timestamp 与合法关联 ID 沿 SDK，不变造为其它语言 schema。过滤同步执行，没有独立异步排队，沿官方有界 flush。

sendClientReports=true 保留 SDK 丢弃记录；client_report 只接受安装版有限 reason/category 和正整数 quantity。Cloudflare 11.12 没有公开自动排空路径，本次不调用 protected _flushOutcomes，也不包装 recordDroppedEvent 重造聚合；自动投递仍未完成，不称真实报告验收通过。

Worker 没有 browserSession，不创建 session/sessions；profile/profile_chunk、check_in/Cron、Replay、附件与其它未知 item 仍拒绝。真实 SDK/HTTP receiver 验固定日志、未采样请求指标、scope 回填/晚期注入过滤与发送失败隔离；client_report 仅作 schema 白名单测试，生产接收另验。

## Go 应用契约

`voices version` 输出编译版本，默认 dev，不连接数据库。UPDATE_URL 未设置时使用 https://voices.niceeval.com/，显式为空时禁用检查；否则必须是无凭据、查询和 fragment 的完整 HTTPS 地址。

地址由部署者控制，其运营者控制公告与链接。客户端可关闭统计参数；UPDATE_TELEMETRY 启用且非恢复模式时按统计方案发送安装 ID 与运行环境，从不发送业务数据，不跟随重定向。超时5秒、响应上限256 KiB。

`internal/updates` 校验必填字段、类型、schemaVersion、稳定版本、HTTPS 链接、时间和公告 ID。畸形响应整体拒绝。缓存只存在内存，重启可重新获取，不写数据库。

GET /api/v1/admin/updates 读取缓存，不请求上游。POST 同路径同步等待手动检查，复用管理员、session、CSRF、来源和恢复模式保护。

响应字段：

- current_version、latest_version、update_available、status。
- checked_at：最近一次实际请求完成时间；last_success_at：最近版本检查成功时间。
- release_url、released_at、release_notes、announcements。

status 是 disabled、unchecked、ok 或 error。无对应时间或版本时返回 null；空正文为空字符串，空公告为空数组。

只有稳定版本之间进行比较，远端版本更大才提示更新。dev 或非法构建版本不声明可比较；界面标记开发版本。

## 缓存状态

| 事件 | 状态与结果 |
| --- | --- |
| 地址为空 | disabled，不发请求 |
| 启用但未尝试 | unchecked |
| 完整合法且版本非空 | ok，替换版本与公告，更新两项时间 |
| 完整合法但版本为空 | error，仅替换公告，保留旧版本与成功时间 |
| 网络、超时、过大或畸形响应 | error，保留旧版本、公告和成功时间 |
| 合并或节流请求 | HTTP 200 返回当前结果，不改变时间 |

实际请求结束更新 checked_at。合法空公告数组即撤回全部公告。每次读取按当前时间过滤公告，即使保留旧缓存也不展示过期内容。

界面区分检查失败、尚未检查、未启用与已是最新版本。失败显示最后成功时间，不能以旧缓存判断当前已是最新版本。上游错误详情不下发客户端。

## 生命周期

Manager 属于应用 context，启动立即检查，此后每24小时检查。并发检查合并为一个请求，完成后至少60秒才可再次请求。

手动检查的 caller 取消仅退出自身等待，不取消共享请求。应用 context 取消后拒绝新检查、取消并 join 进行中的请求。

main 等待更新 Manager、原后台任务及 HTTP Shutdown 结束。Shutdown 超时则 Close 断开连接，不能在 Shutdown 返回前直接退出进程。

## UI

服务器设置页增加独立组件，显示构建版本、版本状态、检查按钮、发布链接、纯文本更新日志和公告。请求错误显示重试入口。

外链只接受 HTTPS 且使用 noreferrer。禁用或恢复模式下不能手动检查。移动端换行且不横向溢出，不引入自动安装或强制阻断。

## 验收

- Worker 正式 handler：路由、上游失败、排序、分页、时间窗口、缓存、大小限制、统计关闭与参数校验及写入失败隔离。fake 只模拟 GitHub/Cloudflare 边界。
- Go：版本比较、状态转换、成功缓存保留、并发合并、超时/取消、畸形/过大响应。
- 真实 App HTTP + PostgreSQL：管理员成功、普通账号拒绝、未登录拒绝、CSRF 与恢复模式写入拒绝。
- 浏览器：状态分支、真实管理员手动检查、日志与公告、HTML 不执行、移动端无溢出。
- 发布：actionlint、防回退检查、本地 Docker 构建、version、healthcheck、静态资源。远端发布须授权后验收。

## 验收边界

发布验证 latest 不回退、手动检查退出时的资源归属及部分失败缓存行为；同时检查分页完整性、响应字节预算、受信 endpoint、部署权限和真实浏览器流程。

## 参考

- [Cloudflare Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- [Go HTTP Shutdown](https://pkg.go.dev/net/http#Server.Shutdown)
- [GitHub Releases API](https://docs.github.com/en/rest/releases/releases#list-releases)

## 发布产物

沿用 OpenTickly 的 tag 发版流程：Docker Hub 仓库 correctroad/voices，镜像标签为 X.Y.Z、X.Y、SHA 和 latest。DOCKERHUB_USERNAME 与 DOCKERHUB_TOKEN 仅在 image job 使用。Registry 查询错误不视为首次发布；仅明确 latest 不存在可跳过镜像版本比较。

GitHub Release 同时提供 voices-linux-amd64.tar.gz、voices-linux-arm64.tar.gz 和 SHA256SUMS。每个压缩包包含对应架构的 voices 可执行文件、同一 tag 构建的 web/ 静态资源及运行说明；运行需要 PostgreSQL 与 ffmpeg，默认从解压目录启动并设置 WEB_DIR=web。前端只构建一次供两个发布包共享。发布等待镜像和发布包都成功，不自动创建或推送 tag。
