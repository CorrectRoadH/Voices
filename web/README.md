# Voices Web

中文录音工作台，使用 React / TypeScript、Vite+ 1.3.0 和官方 shadcn Base UI 源码组件。业务数据、上传、音频与导出均调用 Go API；生产源码不包含示例业务数据或 mock 服务。

## 开发

```sh
cd web
pnpm install --frozen-lockfile
pnpm dev
```

需要 Node 22.22.3+ 或 24.11+。开发服务器将 `/api` 代理至 `http://localhost:18080`；登录密码、数据库与服务商凭据由 Go 服务配置。浏览器仅接收会话、CSRF 和非秘密偏好，不接收服务商密钥。

```sh
pnpm generate:api   # 从 ../docs/api/openapi.json 生成 src/lib/api.generated.ts
pnpm typecheck
pnpm test
pnpm build
pnpm preview
```

按 [Vite+ 官方本地安装文档](https://viteplus.dev/guide/local-cli) 配置，工具链入口均为 `vp`；`vite` 依赖通过 pnpm override 指向同版本 `@voidzero-dev/vite-plus-core`，测试使用 `vite-plus/test` 与内置 Vitest。部分第三方包按 Vite 的主版本声明 peer，pnpm 会针对 core 的 1.3.0 包版本显示 peer 提示；本项目实际使用的 Vite 核心版本可由 `pnpm exec vp toolchain` 查看。

## 部署路径前缀

构建和开发均读取 `PUBLIC_BASE_URL`，例如：

```sh
PUBLIC_BASE_URL=https://voices.example/voices/ pnpm build
PUBLIC_BASE_URL=/voices/ pnpm dev
```

Go 服务的 `PUBLIC_BASE_URL` 应使用同一部署路径；它通过 `/session` 返回完整公开 URL，供句子引用生成使用。静态服务需将此前缀下的前端路由回退至构建后的 `index.html`，并将此前缀下的 `/api/v1` 路由交给 Go API。API 与静态页面保持同源。路径前缀是构建参数，改变前缀后需要重新构建前端。

## 浏览器验证

```sh
pnpm exec e2e-web install chromium
TEST_DATABASE_URL='postgres://user:password@localhost:5432/voices_test?sslmode=disable' pnpm test:e2e
# NixOS 等环境可以指定已安装且带有运行库的 Chromium：
E2E_CHROMIUM_EXECUTABLE_PATH=/run/current-system/sw/bin/chromium TEST_DATABASE_URL=... pnpm test:e2e
```

浏览器测试统一使用 [tester-army/e2e](https://github.com/tester-army/e2e)。中文用例位于 `tests/*.e2e.ts`；`test:e2e` 构建前端并通过 Go fixture 启动真实 HTTP、隔离 PostgreSQL 和后台任务。仅外部 STT、LLM、更新服务使用 fake；不配置测试代理模型，不调用真实付费服务。

engine 管理浏览器生命周期，Go fixture 清理服务器、任务和 schema。失败报告与截图位于 `.e2e/<流程>/`。`pnpm typecheck` 同时检查应用和 e2e 用例。未设置测试数据库时入口直接失败，不把跳过当作通过。

保留安全返回路径、稳定引用、模型能力、HTTP 故障和翻译完整性单元测试；权限、幂等、并发和资源回收由真实 Go/PostgreSQL 测试验证。完整分工见 [交付机制](../docs/engineering/delivery/README.md#测试分工)。
