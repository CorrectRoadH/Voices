---
format: concord.document/v1
id: release-updates-acceptance
title: 发布、CI 与更新服务验收
createdAt: 2026-10-18T06:47:15.296Z
kind: memory
memoryKind: note
state: captured
epoch: 0
promotions: []
history: []
---

# 发布、CI 与更新服务实现验收

用户授权从 OpenTickly 移植发布、CI、Docker 和更新服务；未授权实际 push、tag、发布或部署。主 agent 编写方案，Herdr 原生 Codex / GPT-6.1 Sol Review 挑战 latest 回退、手动检查退出生命周期及部分失败缓存规则。修正结论见 docs/research/release-updates/README.md。Review 只读，无执行 worker；本轮 review pane w4X:pB 已回收。

实现 .github/workflows/ci.yml、release.yml、update-worker-deploy.yml；GHCR 多架构镜像、版本注入、git-cliff 发布说明及版本防回退。Worker 独立公告 JSON 与 GitHub 稳定版本查询；Go 实例内缓存、并发检查合并、取消/退出；管理员设置页版本、纯文本日志与公告。无数据库迁移、无实例统计。

验证：

- 独立 PostgreSQL 容器运行当前 sh scripts/test.sh，通过全部常规 Go 测试、go vet、21项前端单元测试、前端构建/typecheck、8项 Worker 测试及4项发布版本门禁测试。
- go test -race ./internal/updates -count=1 通过。默认 gcc 不在 PATH，改用本机已存在的 gcc-wrapper 绝对路径后通过，没有安装系统工具链。
- VOICES_BROWSER_TEST=1 go test ./internal/app -run 'Test.*Browser' -count=1 -v 通过，包含实际 Go/数据库的版本公告页面验收。截图 /tmp/voices-updates-desktop.png 与 /tmp/voices-updates-mobile.png 是临时证据。
- Playwright 23项：首跑21项通过，2项因 Chromium ERR_NETWORK_CHANGED 未加载页面；trace 指向与 Docker 构建并行期间的网络事件。仅重跑这2项均通过，未修改业务代码、选择器或超时。
- Worker frozen-lockfile install、check、test、Wrangler deploy --dry-run 通过，无部署。
- Docker 最终本地 amd64 镜像构建成功；以只读文件系统、uid10001运行，healthcheck、version=0.1.0、首页与静态资源通过。独立 Go linux/arm64 交叉编译通过，未实际运行 arm64 容器。
- actionlint v1.7.12、docker compose config --quiet、生成 OpenAPI 类型无差异、git diff --check、concord check 均通过。
- concord trace gaps 当前更新契约已有 code/test 关系；仍有4项既有 Go-only 契约缺 code 显式关系，不是覆盖率结论。

远端 GitHub Actions、GHCR 多架构推送与 Cloudflare Worker 部署尚未执行。实际启用需配置 Cloudflare environment secrets、部署 Worker 并设置 UPDATE_URL；首次发布后需确认 GHCR package public。预构建镜像用于根路径，子路径沿用源码 build arg。前端有既存大 bundle 提示，本轮未扩展优化。
