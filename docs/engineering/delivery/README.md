---
format: concord.document/v1
id: delivery
title: CI、Docker 与发布
createdAt: 2026-10-18T06:30:10.115Z
kind: engineering
---

# CI、Docker 与发布

## 目标

每次 PR 与 main 更新验证 Go、PostgreSQL、前端和更新 Worker。正式版本的镜像、版本号和 GitHub Release 对应同一 tag。

## 机制

`.github/workflows/ci.yml` 也是可复用发布前检查。使用独立 PostgreSQL 服务，执行 `scripts/test.sh`、生成 API 无差异检查、Playwright 和真实 Go/数据库浏览器验收。Worker 执行 check、test 和 test:runtime；后者构建发布 bundle，在真实 workerd 中验证更新请求及拒绝重定向。Docker 构建检查不推送。

正式 tag `vX.Y.Z` 通过 CI 后构建 amd64/arm64 镜像，注入应用版本，推送 Docker Hub，最后生成 GitHub Release。版本日志由 `cliff.toml` 从提交生成。CI 仅只读权限，发布 job 单独获取 Docker Hub secrets/contents 写入权限。发布与部署命令须由操作者主动执行；本地实现或测试不构成发布授权。

Worker 手动部署工作流单独使用 Cloudflare 凭据。有限安装统计默认开启，可用 UPDATE_TELEMETRY=false 关闭；更新服务可通过空 UPDATE_URL 禁用。

## 使用与验收

[完整契约与设计](../../research/release-updates/README.md) · [部署与恢复](../../operations.md)

CI 的可执行入口为 `.github/workflows/ci.yml`。本地通过单元/集成/浏览器测试、Docker 版本与 healthcheck、actionlint 检查工作流。远端流水线和多架构发布的通过状态只能由实际授权运行证明。

## 发布操作

合并前查看 CI 结果。配置具备 correctroad/voices 推送权限的 DOCKERHUB_USERNAME 与 DOCKERHUB_TOKEN，并将 Docker Hub 仓库设为 public，供用户匿名拉取。GitHub Release job 使用 contents 写权限。

经操作者确认后，在要发布的 main 提交创建稳定 tag，例如 `git tag v0.1.0`，再执行 `git push origin v0.1.0`。此操作会真正启动发布，不属于普通本地测试。

流水线先跑 CI，再发布 `correctroad/voices:0.1.0` 和 `latest`，最后创建带提交日志的 GitHub Release。旧版本和已发布 tag 被拒绝，避免 latest 回退。不要重写 tag。

若镜像成功但 Release 失败，可以重跑同 tag。不要在部分发布尚未处理时发布低版本。若 Release 已成功，则不要重复整条发布流程。

Worker 通过 `Deploy update worker` 手动部署，与应用版本发布分离。需要 Cloudflare secrets；具体配置、公告格式和首次连接步骤见 [Worker 操作说明](../../../update-worker/README.md)。

## 发布产物

沿用 OpenTickly 的 tag 发版流程：Docker Hub 仓库 correctroad/voices，镜像标签为 X.Y.Z、X.Y、SHA 和 latest。DOCKERHUB_USERNAME 与 DOCKERHUB_TOKEN 仅在 image job 使用。Registry 查询错误不视为首次发布；仅明确 latest 不存在可跳过镜像版本比较。

GitHub Release 同时提供 voices-linux-amd64.tar.gz、voices-linux-arm64.tar.gz 和 SHA256SUMS。每个压缩包包含对应架构的 voices 可执行文件、同一 tag 构建的 web/ 静态资源及运行说明；运行需要 PostgreSQL 与 ffmpeg，默认从解压目录启动并设置 WEB_DIR=web。前端只构建一次供两个发布包共享。发布等待镜像和发布包都成功，不自动创建或推送 tag。
