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

`.github/workflows/ci.yml` 也是可复用发布前检查。使用独立 PostgreSQL 服务，执行 `scripts/test.sh`、生成 API 无差异检查、Playwright 和真实 Go/数据库浏览器验收。Worker 执行 check、test 和 Wrangler dry-run。Docker 构建检查不推送。

正式 tag `vX.Y.Z` 通过 CI 后构建 amd64/arm64 镜像，注入应用版本，推送 GHCR，最后生成 GitHub Release。版本日志由 `cliff.toml` 从提交生成。CI 仅只读权限，发布 job 单独获取 packages/contents 写入权限。发布与部署命令须由操作者主动执行；本地实现或测试不构成发布授权。

Worker 手动部署工作流单独使用 Cloudflare 凭据。无实例遥测，更新服务可禁用。

## 使用与验收

[完整契约与设计](../../research/release-updates/README.md) · [部署与恢复](../../operations.md)

CI 的可执行入口为 `.github/workflows/ci.yml`。本地通过单元/集成/浏览器测试、Docker 版本与 healthcheck、actionlint 检查工作流。远端流水线和多架构发布的通过状态只能由实际授权运行证明。

## 发布操作

合并前查看 CI 结果。GitHub Actions 必须允许该仓库 token 写入 Packages；首次发布后将 GHCR package 可见性设为 public，公开用户才能匿名拉取。

经操作者确认后，在要发布的 main 提交创建稳定 tag，例如 `git tag v0.1.0`，再执行 `git push origin v0.1.0`。此操作会真正启动发布，不属于普通本地测试。

流水线先跑 CI，再发布 `ghcr.io/correctroadh/voices:0.1.0` 和 `latest`，最后创建带提交日志的 GitHub Release。旧版本和已发布 tag 被拒绝，避免 latest 回退。不要重写 tag。

若镜像成功但 Release 失败，可以重跑同 tag。不要在部分发布尚未处理时发布低版本。若 Release 已成功，则不要重复整条发布流程。

Worker 通过 `Deploy update worker` 手动部署，与应用版本发布分离。需要 Cloudflare secrets；具体配置、公告格式和首次连接步骤见 [Worker 操作说明](../../../update-worker/README.md)。
