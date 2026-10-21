# Voices 命令

| 命令 | 输入与结果 |
| --- | --- |
| `voices` | 从环境与 .env 读取基础参数、迁移数据库，首次导入业务配置并以数据库值启动 HTTP 服务与后台任务。SIGINT/SIGTERM 停止领取并等待退出 |
| `voices resolve-job <job-id> <operation-id> <remote-id>` | 本机运维核对远端资源归属后登记，从标准输入读取核对说明；保留恢复隔离规则并记录审计 |
| `voices reset-password <email>` | 从标准输入读取新密码，更新已有账号并撤销全部会话；不改变角色和启停状态 |
| `voices hash-password` | 从标准输入读取一行密码，输出 bcrypt 哈希。空输入返回非零；不需要数据库配置 |
| `voices healthcheck` | 请求本机监听端口的固定 /healthz，不依赖公开路径前缀。数据库不可用、HTTP 非 200 或超时返回非零 |

容器入口为 `voices`。健康检查不调用外部转写服务，不携带管理员凭据。账号通过页面注册，不使用共享环境密码。哈希命令仅用于本地生成 bcrypt 哈希，不参与服务启动，输出不能公开。

## 仓库根目录开发命令

- `air .`：从根目录 `.env` 加载后端配置，监听 Go / SQL 文件变化并重启后端。
- `pnpm dev`：启动前端开发服务器，固定端口 5173，API 代理至 18080。
- `pnpm build`：类型检查并构建前端。
- `pnpm test`：运行 Go 单元与数据库集成测试、前端单元测试、Worker 单元测试和发布规则测试；要求 `TEST_DATABASE_URL`。
- `pnpm check`：运行 `pnpm test`，再执行 Go vet、前端类型检查与构建、Worker 类型检查；不包含浏览器、大文件和 Worker runtime 验收。
- `pnpm test:go` / `pnpm test:web` / `pnpm test:worker` / `pnpm test:release`：分别运行上述常规测试；只有 Go 测试要求数据库。
- `pnpm test:db`：检查是否提供 `TEST_DATABASE_URL`，不启动数据库，也不验证连接。
- `pnpm check:go`：执行 Go vet。
- `pnpm test:e2e`：要求 `TEST_DATABASE_URL`，构建前端并由 Go fixture 启动真实应用、调用浏览器测试和清理资源。
- `pnpm test:worker:runtime`：构建 Worker 并在 workerd 中验收。
- `pnpm db:up`：启动 `compose.dev.yaml` 中的 PostgreSQL，等待健康检查通过。
- `pnpm db:down`：停止开发数据库，保留数据卷。

开发配置含服务商密钥，`.env` 不入库；Vite 从根目录读取配置，只有 `VITE_` 前缀变量可暴露给浏览器。

## 构建版本

`voices version` 输出编译时注入的版本号，默认 `dev`，不读取配置或连接数据库。正式镜像的版本号对应发布 tag（去掉 `v` 前缀）。
