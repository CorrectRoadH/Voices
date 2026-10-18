# Voices 更新统计与部署方案

## 目标与边界

将已有更新/公告 Worker 发布到 https://voices.niceeval.com/，增加与 OpenTickly 相同字段的实例更新请求统计，并在 it-infra 的 Grafana 展示。统计仅表示主动检查更新的安装实例，不等于人数或完整安装量。保留既有 manifest、缓存、超时、取消与 no-store 语义。不采集录音、转写、用户名、邮箱、主机名、部署 URL 或 IP；国家仅由 Cloudflare request.cf.country 得出。现有无遥测契约由本方案显式替代。

## 客户端身份与生命周期

PostgreSQL 新增 009_instance_identity.sql：instance_identity 单例表。id smallint PRIMARY KEY CHECK(id=1)，instance_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid()。迁移 INSERT id=1 ON CONFLICT DO NOTHING。只读查询，不新建队列/定时器。持久安装身份独立于 App.InstanceID，绝不替换任务租约 owner。数据库是安装身份所有者，多副本共享；重启、升级、备份恢复保留 ID。独立克隆部署须由运维显式更新 UUID；不自动从硬件指纹推导。

UPDATE_URL 未设置时默认 https://voices.niceeval.com/，显式空值禁用；文档示例指向生产域名。新增 UPDATE_TELEMETRY 布尔环境变量默认 true。启用统计且 UPDATE_URL 非空、非恢复模式时，启动使用派生自应用 context 的2秒超时读取 singleton，超时/缺行/失败只禁用统计并告警，不影响应用/更新。恢复模式禁止统计。启动配置冻结，重启应用切换开关。无新增数据库内布尔配置或 UI。

updates.New 保留现有签名；新增 NewWithTelemetry(..., telemetry *Telemetry) 构造入口，New 委托它。Telemetry 只包括 InstanceID，运行环境从 runtime.Version/GOOS/GOARCH 取得，版本沿用构造参数。每次实际 GET 检查附加 instanceId、version、goVersion、os、arch；locale 暂不发送（服务端没有实例语言权威来源）。无身份则不附加任何字段。仍复用启动/每日/管理员检查及并发合并和60秒节流，无独立心跳。Go 网络错误不回显完整 URL。

## Worker 接口与 Analytics Engine

GET / 所有参数可选，分别校验并丢弃不合规字段：instanceId UUID；version 长1..64且 [A-Za-z0-9._+-]；goVersion/os/arch/locale 长1..32且 [A-Za-z0-9._+/-]。未知字段忽略。仅同时有合法 instanceId、version 时在 ctx.waitUntil 写一个点；无 binding/写入失败均不影响 manifest。统计参数不转发 GitHub，也不进入缓存 key。

绑定 UPDATE_REQUESTS -> dataset voices_update_requests，index1=instanceId，blob1..6=version/goVersion/os/arch/locale/country，无 doubles。数据由 Cloudflare Analytics Engine 管理，遵守平台保留期，无应用自建持久库。公开参数可伪造，统计无鉴权且仅为产品趋势，不能用于账单或安全审计。验收探针版本为 smoke，Grafana 查询全部排除 blob1='smoke'，避免测试冒充真实安装。

## 部署与 Grafana

Worker 保持 voices-update-worker 名称、CorrectRoadH/Voices 来源及cf 构建部署工作流。域名用 Workers custom domain，避免手写目标不明的 A/CNAME。使用 cf/config 和 Cloudflare Vite 插件构建；移除旧 CLI 配置与依赖，不复制输出 OAuth 凭据。部署前核对远端已有脚本/域名，防止覆盖不明部署。

it-infra main 新增 k3s/grafana/voices-dashboard.yaml，并加入 kustomization 与 projected volume；复用 cf-ae 数据源和既有 secret，不新增 token。借鉴 opentoggl 仪表盘：日/周/月活跃检查实例、请求量、日趋势、版本/OS/架构/国家分布。请求量使用 SUM(_sample_interval) 加权；独立实例为采样中观察到的去重数，不外推总体。

版本/环境分布表示期间观察到的值，同一实例可进入多个桶，桶不可相加。多副本增加请求量，60秒节流只在单 Manager 内生效。不声称准确用户数。用户已要求 Grafana 接上，但若推送会包含与本任务无关的本地提交，先隔离/核实，不推未知内容。遵守 Argo GitOps，不 kubectl apply。

## 验收

Worker handler 测试合法/非法/缺失参数、写失败、缓存命中仍统计、无 query 转发；Go 测试开启/关闭参数及保留既有生命周期。真实 PG 验证迁移单例、重开稳定、约束。Worker check/test/build；Go focused tests；Concord docs/trace 与 git diff --check。生产验证 DNS/TLS、manifest schema、404/405、一次 smoke 请求和 AE SQL 数据可见；Grafana 查询经现有数据源成功并截图检查。无正式版本允许 latestVersion=null，需明确说明。生产应用尚未部署新版本时，不宣称已有真实客户端采集。

## 独立审查

原生 Codex / GPT-6.1 Sol（Herdr voices-telemetry-review）结论 CONDITIONAL：有界身份读取、统计口径和旧契约同步是实现前条件。主 agent 采用上述2秒超时、独立身份、明确查询口径并同步 Feature/Use Case/旧设计后收敛。
