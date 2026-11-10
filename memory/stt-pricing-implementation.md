# STT 时长估算费用实现与验收

## 范围

依据 `docs/design/stt-pricing.md` 采用逐 submit 意图快照，迁移固定使用 023。
保持外部请求日志与费用记录的粒度独立。真实服务商调用不作为自动化验收边界。

## 环境与前置核验

初始分支 `feat/stt-pricing`，工作区干净。
本轮隔离 PostgreSQL 使用端口 55483，测试由 fixture 创建独立 schema 并清理。
默认 PATH 无 C 编译器，显式 CC 指向已安装 GCC wrapper 后，现有调用日志生命周期测试通过。

`concord trace gaps --json` 报 `HawdbUnavailable: Native artifact does not support asynchronous cache ownership`。
命令级模式报 `WorkspaceServerBusy`，未停止或重启现有服务。

## 设计审查

通过 Herdr 独立原生 Codex / GPT-6.1 Sol Review，审查费用留存、删除关联、管理员读取与状态同步边界。
审查发现删除会覆盖已成功/失败费用结果，及恢复合成 submit 缺失费用记录两项 P1。
主 agent 采用删除期保留已结束结果、恢复观察独立来源且未定价两项修正。
精确金额使用 numeric 乘积与 div 整数商，不用先舍入的除法。
价格选择明确为触发器内一次 SELECT 可见的已提交版本，不宣称调用语句起点快照。
任务 attempt 明确为当前任务重试计数，不声称累计失败次数。
评审报告归档于本地 `/tmp/stt-price-design-review.md`；worker 已终止和移除。

## 实现与验证结果

迁移 023 通过触发器在真实 prepared submit 事务内保存价格快照。
操作、任务结果同事务同步，删除只清业务外键，恢复观察保持未定价。
四个管理员 API、追加价格审计、OpenAPI 类型与两个管理界面已实现。

验证命令均使用本轮隔离 PostgreSQL；CC 显式指向已安装 GCC wrapper。

- `vp run check`：通过，包含全套 Go/PostgreSQL、web/worker、vet、构建与发布检查。
- `./scripts/go.sh test ./...`：通过，internal/app 及其它包均通过。
- `./scripts/go.sh test ./internal/app -run TestSTTPricing -count=1 -v`：8 项非浏览器测试通过。
- `vp -C web run check`：通过，含 i18n 与 TypeScript；有非阻塞 lint 警告。
- `VOICES_BROWSER_TEST=1 ./scripts/go.sh test ./internal/app -run TestSTTPricingBrowser -count=1 -v`：通过。
- `concord check --json`：关系与写作检查通过，零 finding。
- `concord trace gaps --json`：仍受 HawDB 原生缓存异步所有权能力阻塞，不能声称 trace 无缺口。

覆盖真实 submit、prepared 复用、明确重转、缺价、并发价格可见性、历史迁移、恢复观察、同键并发创建、CSRF、匿名/降级权限、分页、精确微元、溢出与删除保留。
默认浏览器测试有环境开关，上述浏览器命令单独实际执行，不以默认 skip 当作通过。

浏览器模型配置缺失，使用系统 Chromium 和已安装 Playwright 核心做确定性真实入口验收。
无新依赖，无真实付费 STT。截屏位于 `web/.e2e/stt-pricing/`，为忽略的本地取证产物。
已查看桌面调用页及手机深色价格页，375px 无横向溢出、无浏览器异常。
验证价格非法输入保留草稿、保存忙碌、历史价格和旧调用费用不变。

设计 Review 与测试终端均由主 agent 验收和回收；不停止用户的 core/app。
隔离数据库完成验证后停止，fixture 自行清理所有测试 schema。
