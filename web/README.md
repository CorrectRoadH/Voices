# Voices Web

中文录音工作台，使用 React / TypeScript、Vite+ 1.3.0 和官方 shadcn Base UI 源码组件。业务数据、上传、音频与导出均调用 Go API；生产源码不包含示例业务数据或 mock 服务。

## 开发

```sh
cd web
pnpm install --frozen-lockfile
pnpm dev
```

需要 Node 22.18+ 或 24.11+。开发服务器将 `/api` 代理至 `http://localhost:8080`；登录密码、数据库与服务商凭据由 Go 服务配置。浏览器仅接收会话、CSRF 和非秘密偏好，不接收服务商密钥。

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
pnpm exec playwright install chromium
pnpm test:e2e
# NixOS 等环境可以指定已安装且带有运行库的 Chromium：
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/run/current-system/sw/bin/chromium pnpm test:e2e
```

Playwright 启动并回收独立 Vite+ 开发服务器，使用 `/voices/` 前缀。测试只拦截 HTTP 外部边界；页面、路由、XHR、播放器、剪贴板 fallback 和编辑表单均运行真实实现。音频测试响应提供真实 WAV 与 Range 头。测试不连接付费服务商。

单元测试覆盖 Markdown、稳定归属、登录返回路径、能力限制和 HTTP 故障；浏览器覆盖历史版本分页锚点、登录后返回、无时间戳、revision 冲突、上传顺序、uncertain 核对和移动布局。Go API 与 PostgreSQL 的真实集成及服务商样本验收由主 agent 完成。
