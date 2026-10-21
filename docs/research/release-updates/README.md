---
format: concord.document/v1
id: release-updates
title: 发布与更新服务设计
createdAt: 2026-10-18T06:30:09.673Z
kind: research
sources: []
---

# 发布与更新服务设计

## 目标与边界

复用 OpenTickly 的 GitHub Releases、Cloudflare Worker、站内版本与公告机制。GitHub Release 是发布说明唯一来源。

不新增官网或自动升级。实例统计与持久安装身份按 [统计与部署方案](telemetry.md) 提供，默认开启（UPDATE_TELEMETRY=false 可关闭）。现有录音与转写服务不依赖更新服务的可用性。

## 发布与 CI

CI 对 PR、main push 和手动触发执行 Go test/vet、独立 PostgreSQL 集成测试、前端 typecheck/test/build、e2e 真实应用浏览器验收。

Worker 独立执行 check/test 和 cf build。依赖使用锁文件，Docker 构建检查不推送镜像。

正式 tag 为 `vX.Y.Z`，版本分量不超过 4294967295。CI 通过后构建 Linux amd64/arm64 镜像，发布到 Docker Hub。镜像成功后从提交生成 GitHub Release 正文。

所有 job 使用触发 tag 的 SHA，tag 不得重写。应用 `main.version` 注入同一 tag。容器保留 ffmpeg、非 root、healthcheck，无应用数据卷。

全局 release concurrency 串行。镜像发布前读取 GitHub 全部分页正式 Releases，拒绝低于或等于已发布最大版本的 tag。

同时读取 Docker Hub latest 的版本标签，拒绝降级。只有明确不存在的 package 才允许首次发布；认证或网络失败中止。同 tag 镜像成功而 Release 失败可重跑。

CI 仅有只读权限；镜像和 Release job 分别获取 Docker Hub secrets/contents 写入权限。Worker 只允许 main 手动部署，Cloudflare token 限定目标账户与 Worker。

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

GITHUB_REPO 为部署配置 CorrectRoadH/Voices；GITHUB_TOKEN 为可选服务端 secret。GitHub 请求总超时 5 秒，不跟随重定向。

每页100条，最多10页；仍有下一页则返回未知版本，不从不完整集合推断最大版本。过滤 draft、prerelease 和非法 tag，按数值取最大稳定版本。

GitHub 上游 HTTP 200 响应通过 Cloudflare fetch 缓存5分钟，重定向和错误响应不缓存。缓存按公开上游 URL 复用，不包含客户端统计参数。Cloudflare Cache API 另缓存成功版本快照5分钟，缓存故障不影响上游成功结果。公告每次请求重新过滤，HTTP 响应 no-store。GitHub 失败返回 null 版本和有效公告，HTTP 200。

公告来自 `content/announcements.json`，随 Worker 部署。字段 id、title、body、severity、publishedAt、expiresAt、link 必须完整；后两项可为 null。

severity 为 info/warning/critical；时间使用 UTC RFC3339。ID 唯一、过期晚于发布、链接仅 HTTPS。过滤未来及已过期公告，按发布时间降序。

公告包最多20条和64 KiB JSON。id/title/body 分别最多100/200/4000 UTF-16 code units。发布正文超过32000 code units时截断并明确提示，完整内容通过发布链接访问。

最终响应最多256 KiB。正文仅作纯文本展示，不执行 HTML。没有公告时使用空数组，不发布虚构内容。

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

界面区分检查失败、尚未检查、未启用与已是最新版。失败显示最后成功时间，不能以旧缓存判断当前已是最新版。上游错误详情不下发客户端。

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

## 审查结论

Herdr 原生 Codex / GPT-6.1 Sol Review 要求先收敛 latest 回退、手动检查退出归属和部分失败缓存三项边界。以上发布规则、生命周期和状态表是主 agent 采用的修正结论。

分页完整性、响应字节预算、受信 endpoint、部署权限和真实浏览器门控也已纳入契约。设计审查不替代实现与运行时验收。

## 参考

- [Cloudflare Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- [Go HTTP Shutdown](https://pkg.go.dev/net/http#Server.Shutdown)
- [GitHub Releases API](https://docs.github.com/en/rest/releases/releases#list-releases)

## 发布产物

沿用 OpenTickly 的 tag 发版流程：Docker Hub 仓库 correctroad/voices，镜像标签为 X.Y.Z、X.Y、SHA 和 latest。DOCKERHUB_USERNAME 与 DOCKERHUB_TOKEN 仅在 image job 使用。Registry 查询错误不视为首次发布；仅明确 latest 不存在可跳过镜像版本比较。

GitHub Release 同时提供 voices-linux-amd64.tar.gz、voices-linux-arm64.tar.gz 和 SHA256SUMS。每个压缩包包含对应架构的 voices 可执行文件、同一 tag 构建的 web/ 静态资源及运行说明；运行需要 PostgreSQL 与 ffmpeg，默认从解压目录启动并设置 WEB_DIR=web。前端只构建一次供两个发布包共享。发布等待镜像和发布包都成功，不自动创建或推送 tag。
