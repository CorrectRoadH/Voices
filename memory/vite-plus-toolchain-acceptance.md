---
format: concord.document/v1
id: vite-plus-toolchain-acceptance
title: Voices 与 OpenTickly 的 Vite+ 工具链统一验收
createdAt: 2026-10-21T10:24:29.931Z
kind: memory
memoryKind: insight
state: current
epoch: 0
promotions: []
history: []
---

# Vite+ 工具链统一验收

2026-10-21 用户批准统一 Voices 与 OpenTickly 的 vp 工具链入口。Voices 保留三个独立安装根及其锁文件，使用 Vite+ 1.3.0；OpenTickly workspace 从 0.1.18 升级到 1.3.0 / Vitest 5.0.5，保留 pnpm 10.32.1。没有合并两仓库或更改部署架构。

Voices 根脚本、CI、Docker、Concord runner 和 Go 浏览器 fixture 改用 vp。前端/Worker 新增格式、lint、类型检查，保留 tsc、翻译完整性和真实运行时验收。Oxfmt 建立格式基线，生成 API 文件排除并单独验证无差异；原有未提交改动保留。新版类型检查移除已不支持的 tsconfig baseUrl，原路径映射保持不变。

OpenTickly 更新测试导入、jest-dom/vitest 类型与 Node 支持范围。生成 React Router 类型和 Worker 内容先于检查。根测试增加明确的 test:unit 入口；CI/Docker 使用 frozen lockfile，专用 React Router/Fumadocs/Cloudflare 命令仍通过 vp exec 保留。

关键经验：`vp run -r build` 的 runner 参数必须在任务名前；旧 `vp run build -r` 在本次环境中没有执行子包构建。任务参数直接放在任务名后；多余的 `--` 会传到 Playwright，导致其配置参数没有生效。项目脚本使用 `vp exec node`，因为项目本地 CLI 不支持全局 CLI 的 `vp node` 简写。内置 `vp check` 不等于项目门禁 `vp run check`。

验证：
- Voices：隔离 PostgreSQL 上 `vp run check` 通过（Go 单元/集成、15 项前端单测、10 项 Worker 单测、发布规则、Go vet、类型和构建）；`vp run test:worker:runtime` 两项真实 workerd 验证通过。
- Voices：`TestInterfaceLanguageBrowser` 在真实 Go/PostgreSQL/系统 Chromium 上通过，实际通过 vp exec 启动 e2e；测试代理使用已有 E2E 模型配置，被测应用外部服务仍 fake。浏览器释放记录可见。未重跑全套浏览器用例或大文件上传。
- Voices：完整 Docker 镜像构建通过，`docker run --rm voices:vp-local version` 返回 0.0.0；生成 API 无差异、actionlint、Concord check/trace check、git diff --check 通过。
- OpenTickly：`vp run check`、`vp run test:unit`（61 文件/238 测试）、`vp run build` 通过；Docker 的 website-builder 和 landing builder 两个修改阶段构建通过。
- OpenTickly：通过正式根入口运行 app-shell.spec.ts，6 项真实 PostgreSQL/Redis/浏览器用例通过，retries=0；登录页 screenshot 无 pageerror。NixOS 验证用临时 bwrap 时区挂载和系统 Chromium 配置，未更改产品。截图中部分 CJK 标签缺字，为本机浏览器字体环境观察。

所有本轮测试服务器、PostgreSQL、Redis 容器、临时仓库内 Playwright 配置已清理；无新增 pane/tab/worktree。本地镜像与测试报告保留供复查。仍有非阻塞 lint 警告。未提交、push、发布、部署，未运行远端 CI；OpenTickly 未重跑全套浏览器/CLI 集成和后端测试。
