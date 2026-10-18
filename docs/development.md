# 开发与测试

需要 Python 3、Go 1.26、Air、Node.js 24.11+、pnpm、Docker、FFmpeg/ffprobe。命令均在仓库根目录执行，命令说明见 [命令](cli.md)。

## 本地运行

参考 `.env.example` 在根目录创建 `.env`，至少设置：

```sh
DATABASE_URL=postgres://voices:password@127.0.0.1:54329/voices?sslmode=disable
LISTEN_ADDR=0.0.0.0:18080
PUBLIC_BASE_URL=http://<本机局域网 IP>:5173
# 可选：SONIOX_API_KEY / ASSEMBLYAI_API_KEY
```

```sh
pnpm --dir web install --frozen-lockfile
pnpm --dir update-worker install --frozen-lockfile
pnpm db:up        # 开发 PostgreSQL，仅绑定 127.0.0.1:54329
air .             # 终端一：后端热重启
pnpm dev          # 终端二：前端 5173，API 代理到 18080
```

访问 `PUBLIC_BASE_URL` 指定的地址；登录来源须与它一致，更换 IP 或主机名时同步修改并重启。`pnpm db:down` 停止数据库并保留数据卷。前端只暴露 `VITE_` 前缀的环境变量。业务配置的数据库优先规则见 [运维](operations.md#配置)。

## 测试

```sh
# 独立测试数据库；每个测试使用随机 schema 并清理。
TEST_DATABASE_URL='postgres://user:password@localhost:5432/voices_test?sslmode=disable' sh scripts/test.sh
# 大文件验收：约 1 GiB 与接近 2 GiB 的 WAV。
VOICES_LARGE_TEST=1 TEST_DATABASE_URL=... CGO_ENABLED=0 go test ./internal/app -run TestLargeHTTPUploadsBoundedMemory -v
# 真实浏览器端到端：先构建 web；只替换外部 STT HTTP。
# 可用 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 指定 Chromium。
VOICES_BROWSER_TEST=1 TEST_DATABASE_URL=... CGO_ENABLED=0 go test ./internal/app -run TestBrowserFullStack -v
concord check --json
concord doctor --json
```

未设置 `TEST_DATABASE_URL` 时 Go 集成测试会跳过，这不算数据库验收通过。服务商测试只替换外部 HTTP 边界，不调用真实付费 API。
