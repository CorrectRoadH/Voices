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

`.github/workflows/ci.yml` 也是可复用发布前检查。使用独立 PostgreSQL 服务，执行 `vp run check`、生成 API 无差异检查和 `vp run test:e2e` 真实 Go/数据库浏览器验收。`vp run check` 包含前端与 Worker 的格式、lint、类型检查、常规测试、Go vet、前端类型检查与构建、Worker 类型检查；`vp run test:worker:runtime` 单独构建发布 bundle，在真实 workerd 中验证更新请求及拒绝重定向。Docker 构建检查不推送。

### CI 并行与缓存

常规检查与三个浏览器分片使用独立 job，各自拥有 PostgreSQL 服务。常规检查执行完整 `vp run check`、API 生成检查和 workerd 验收；浏览器 job 只安装 web 依赖，通过 `vp run test:e2e -run` 选择场景。三个分片合计覆盖完整 E2E 集合，Docker 检查与它们并行。发布必须等待所有检查通过，不缓存测试结果，也不因缓存命中跳过安装校验或测试。

浏览器 job 在下载依赖前检查模型配置。PR 与 main 上的新提交取消同一 ref 的旧 CI；发布调用不启用此取消策略。浏览器场景按实测耗时分成三组：目录与工作台、账号与语言及模型、设置与引导及日志恢复。每个分片内部串行，保留原有超时与零自动重试；模型并发最多为三个浏览器 job。常规检查校验分片恰好覆盖默认 E2E 入口中的每个测试，遗漏或重复均失败。失败报告使用分片独立名称。

Go、包管理器和 Docker 继续使用各自缓存。APT 仅缓存下载的 `.deb`，键包含 runner 镜像、架构、检查类型与依赖锁文件；不缓存系统安装状态。APT 每次更新索引并正常安装，禁用非必要推荐包，使用 Ubuntu 官方 archive 镜像。下载缓存在环境准备成功后立即保存，后续测试失败不丢失已下载依赖。

Chromium 下载目录按系统、架构和 web 锁文件缓存；仍执行引擎自带安装命令以校验所需版本并安装系统库。缓存恢复与下载的实际收益通过 Actions 步骤耗时比较，不预先承诺加速比例。Actions 引用采用核实过的最新稳定补丁版本；已有 SHA 固定引用保留固定方式并标明对应版本。Vite+ 版本继续遵守本仓库工具链约定。

### 工具链入口

JS/TS 命令统一通过 Vite+ 1.3.0；pnpm 仍为底层包管理器，根目录、web 与 update-worker 保持独立安装边界。CI 使用固定版本 setup-vp，安装必须使用 frozen lockfile。`vp run check` 为项目完整门禁，`vp check` 仅为内置静态检查；浏览器、数据库和 workerd 验收不缓存。生成 API 文件由生成结果无差异检查负责，不由 Oxfmt 重写。

### 测试分工

浏览器统一使用 [tester-army/e2e](https://github.com/tester-army/e2e)，固定 SDK 与 web engine 版本。用例位于 `web/tests/*.e2e.ts`，名称、自然语言操作目标和诊断说明用中文。通过真实页面、Go HTTP 和隔离 PostgreSQL 验证操作结果；仅外部 STT、LLM、更新服务使用 fake。网络故障可在浏览器 HTTP 边界注入。

Go fixture 创建隔离 schema、测试账号与外部服务，启动应用任务循环，再调用 e2e runner 执行对应文件。浏览器由 engine 负责关闭，Go 在 runner 结束后回收服务、任务和 schema。测试失败须返回非零状态并保留 e2e 报告；无数据库或零测试不得作为验收通过。

验收流程覆盖录音上传与转写、编辑与人物归属、导出和深链接、账号隔离与密码、服务器自动保存与冲突、模型目录、界面语言、版本更新，以及目录中的生成、失败重试和移动端操作。旧 Playwright runner、独立脚本和整套伪造业务 API 的页面测试移除，以真实流程替代。

默认以自然语言 E2E 验收用户行为，非自然语言测试仅保留不可替代的风险边界。注册、资料、配置、人物、编辑、语言、日志和更新展示的正常路径由浏览器承担，删除重复的直接函数/API 验收。安全跳转、直接越权、CSRF、凭据脱敏、并发事务、幂等、取消、租约、迁移恢复和资源释放保留最小必要案例；外部协议保留有不同处理后果的代表输入。翻译完整性、类型与构建属于静态检查。发布校验和 workerd 验收保留。

精简以实际承接的行为为单位，不按函数数量凑比例；删除前核对 E2E 的入口与结果断言。每项剩余低层测试须能指出浏览器无法稳定验证的具体风险。纯测试组织调整不改变产品契约，也不把多个断言合并为一项来制造删减。

浏览器业务操作统一使用中文 `agent.act(...)`，用精确断言验证结果。文件上传、下载捕获、剪贴板故障、并发时序和网络故障注入由确定性代码控制；不允许代理通过额外重试掩盖预期失败。每个独立场景由 Go fixture 创建独立 schema，不能依赖上一条场景留下的业务状态。

测试代理使用独立的 `E2E_MODEL_BASE_URL`、`E2E_MODEL`（gpt-6.1-sol）与 `E2E_MODEL_API_KEY`，通过 OpenAI Responses 协议调用。e2e 配置用 dotenv 自动加载根目录 `.env`，已导出的环境变量优先；缺少配置直接失败，不切换模型、不降级执行。测试代理会产生真实模型调用；被测应用的 STT/LLM 仍使用 fake。

CI 从仓库 variable 读取 E2E_MODEL，从 Secrets 读取 E2E_MODEL_BASE_URL 与 E2E_MODEL_API_KEY；没有凭据时不跳过或宣称验收通过。e2e 原始产物位于 `web/.e2e/`，CI 失败时仅上传另行生成的脱敏文本副本；压缩包、二进制 trace、图片与符号链接不上传。本地原始诊断产物保持不变。本地可指定 `E2E_CHROMIUM_EXECUTABLE_PATH` 使用系统 Chromium。

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

发布调用 CI 时显式传递 E2E_MODEL_BASE_URL、E2E_MODEL_API_KEY 与 TS_AUTHKEY。若需修复工作流后恢复发布，可从 main 手动运行 Release 并指定已有稳定标签 `release_tag`。工作流将标签解析为固定提交，CI、镜像、前端、二进制与发布说明均使用该提交；版本仍取该标签，不移动标签或跳过检查。

Worker 通过 `Deploy update worker` 手动部署，与应用版本发布分离。需要 Cloudflare secrets；具体配置、公告格式和首次连接步骤见 [Worker 操作说明](../../../update-worker/README.md)。

## 发布产物

沿用 OpenTickly 的 tag 发版流程：Docker Hub 仓库 correctroad/voices，镜像标签为 X.Y.Z、X.Y、SHA 和 latest。DOCKERHUB_USERNAME 与 DOCKERHUB_TOKEN 仅在 image job 使用。Registry 查询错误不视为首次发布；仅明确 latest 不存在可跳过镜像版本比较。

GitHub Release 同时提供 voices-linux-amd64.tar.gz、voices-linux-arm64.tar.gz 和 SHA256SUMS。每个压缩包包含对应架构的 voices 可执行文件、同一 tag 构建的 web/ 静态资源及运行说明；运行需要 PostgreSQL 与 ffmpeg，默认从解压目录启动并设置 WEB_DIR=web。前端只构建一次供两个发布包共享。发布等待镜像和发布包都成功，不自动创建或推送 tag。

## 模型私网接入

浏览器验收通过官方 Tailscale action 使用本仓 TS_AUTHKEY 加入 Tailnet；采用用户指定的 tag:ci 临时节点，结束时由 action post logout 回收。该身份继承基础设施现有 CI 权限，不是仅能访问模型的隔离身份。新增网络授权仅允许 Studio HTTPS；普通检查与 Docker 构建不入网。fork 与 Dependabot PR 没有模型或 Tailnet 凭据，缺配置仍明确失败，不降级为虚假通过。

模型地址保存在 Secret，不出现在源码默认值。网络请求前为完整地址、origin、hostname 和密钥注册日志掩码；连接探针只报告受控结果，不打印原始异常、URL 或响应。访问新模型地址前先完成基础设施 ACL 发布。流水线不配置 exit node 或接受子网路由，不修改 runner 的 DNS 设置。

日志掩码不保护 Actions artifact。上传前对允许的 UTF-8 文本文件替换完整地址、域名、密钥以及 URL 编码形式，跳过包含敏感值的文件路径、非 UTF-8 文件和二进制文件。仅在脱敏步骤成功后上传新目录，不能回退上传原始目录。更新或撤销 Auth Key 通过 Secret 独立完成；网络失败不切回公网模型地址。
