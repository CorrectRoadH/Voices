---
format: concord.document/v1
id: account-isolation
title: 独立账号与首位管理员方案
createdAt: 2026-10-18T02:37:42.056Z
kind: research
sources: []
---

# 独立账号与首位管理员方案


## 定位与已知事实

这是实现方案，功能验收完成前不代表已实现。用户确认每个账号的数据独立，首个注册账号成为系统管理员，不引入团队或成员关系。

原共享密码版本：`internal/app/auth.go` 将所有登录与 `ADMIN_PASSWORD_HASH` 比较，sessions 没有用户关联。`001_initial.sql` 中录音 SHA-256 全局唯一，人物、偏好和幂等键也是全局的。只增加 users 表或修改登录页面不能实现隔离。现有服务端 Cookie、CSRF、PostgreSQL 会话、无状态实例和后台租约机制继续使用。

## 账号与角色

一个 user 就是一个数据隔离单位，本期不建 tenants / memberships 表，不提供切换租户、共享内容或邀请成员。

采用邮箱和密码注册、登录。邮箱去除首尾空白并转为小写，须为单个合法地址且不超过 254 字节。用户名保存在 display_name，1–100 字符、可以重复。邮箱尚未验证所有权，不能用于自动找回。密码不裁剪，至少 6 个字符，最多 72 UTF-8 字节，不要求字符类型组合，使用现有 bcrypt 默认成本保存哈希，服务端从不返回或记录密码/哈希。后续邮箱验证、SMTP 和自助找回独立设计。

角色为 `admin` / `user`，状态为 `active` / `disabled`。系统管理员管理注册开关、账号启停和角色。业务 API 对管理员仍执行自身归属检查，不提供查看他人录音、人物或转写的管理入口。管理员启停、角色修改和注册开关写入不含秘密的审计记录。不能停用或降级最后一个 active admin。相关修改用同一数据库锁串行保护。普通用户可以修改自己的显示名称和密码，不能指定角色、状态或 owner。

首版默认开放注册。管理员可关闭后续注册。关闭时显示明确提示并拒绝新注册，不影响已有用户登录。服务商密钥继续由根目录 `.env` 提供，属于实例配置，所有 active 用户使用同一服务商额度。本期不提供每用户密钥、计费或配额。开放注册意味着注册用户可以发起消耗实例额度的转写，管理员可按部署需要关闭注册。

## 首位管理员的原子产生

使用永久单例 `instance_settings`，字段 `id smallint PRIMARY KEY CHECK(id=1)`。另有 `bootstrap_completed boolean NOT NULL DEFAULT false`、`registration_open boolean NOT NULL DEFAULT true`。迁移插入单例。

注册事务先 `SELECT ... FOR UPDATE` 锁住单例，再检查注册开关及邮箱唯一性。bootstrap 未完成时创建 admin，否则创建 user。用户、首次初始化标记和会话在同一事务提交。失败全部回滚。客户端不得提交 role。多个实例并发注册时只有一个事务得到首次资格。错误密码、重复邮箱或数据库失败不消费资格。此后不得用“当前用户数为零”重新开放管理员抢注。不提供删除账号接口。

初始化应由部署者在对外开放前完成。首位注册按首次成功提交定义，不按页面打开时间或请求抵达时间定义。

## 持久模型与约束

- `users`：`id uuid PRIMARY KEY`。`email text NOT NULL UNIQUE`，存规范化邮箱并加长度与小写 CHECK。`display_name text NOT NULL`。`password_hash text NOT NULL`。`role text NOT NULL CHECK(role IN ('admin','user'))`。`status text NOT NULL CHECK(status IN ('active','disabled'))`。`created_at/updated_at timestamptz NOT NULL`。用户 ID 与业务归属不可变。
- `sessions` 增加 `user_id uuid NOT NULL REFERENCES users(id)`，保留随机令牌摘要、CSRF 摘要与到期时间。新增 `(user_id)` 索引。每次鉴权联查用户 active 状态与实时角色。停用用户或改密码的事务删除其全部会话。修改密码后前端重新登录。
- `recordings`、`people` 增加 `owner_id uuid NOT NULL REFERENCES users(id)` 以及 `UNIQUE(owner_id,id)`。录音去重改为 `UNIQUE(owner_id,sha256)`。列表索引改为 `(owner_id,recorded_at DESC,id)`，人物列表按 owner 建索引。同音频不同用户各自入库，不共享 blob，不暴露全局重复情况。
- `media_assets`、`transcriptions`、`speaker_labels`、`segments`、`jobs`、`provider_resources`、`provider_operations` 增加不可空 `owner_id`。写入值由数据库插入触发器从父实体导出，保留 UUID 主键并增加被引用所需的 `UNIQUE(owner_id,id)`。父子关联改为含 owner 的复合外键。同一录音内的 active version、同一转写内的标签关联继续保留原有更严格约束。speaker label 关联人物必须使用 `(owner_id,person_id)` 外键，阻止跨账号关联。
- `blobs` 增加 `owner_id` 及 `UNIQUE(owner_id,id)`，media asset、raw response 与 blob 使用含 owner 的复合外键。blob 的 job 引用同样含 owner。`blob_chunks` 和 `blob_read_leases` 只通过 blob 继承归属，不提供直接 HTTP 访问入口。后台写入 blob 必须从当前 job 取得 owner。
- `settings` 改为 `(owner_id,key)` 主键，owner 外键指向 users，转写偏好属于个人。实例注册开关单独存放，不复用个人 settings。
- `idempotency_keys` 改为 `(owner_id,scope,key)` 主键，锁键也包含 owner。读取历史结果前仍检查结果归属。任务 dedupe key 使用内部 UUID 资源标识，不能以客户端 key 或纯内容哈希跨账号去重。
- `admin_audit_events`：`id uuid PRIMARY KEY`、`actor_id uuid REFERENCES users(id)`（本地运维操作可空）。另有 `target_user_id uuid REFERENCES users(id)` 可空、`action text NOT NULL`。另有 `created_at timestamptz NOT NULL`、`details jsonb NOT NULL`（白名单角色/状态/开关变化）。按 created_at 与 target_user_id 索引，不存密码和令牌。

业务对象创建、派生 owner、复合外键关联、任务入队和幂等结果保存保持单事务。注册/角色变更锁住单例的事务不执行慢哈希工作：先完成输入校验与密码哈希，锁内完成决定和写入。

## 请求与后台边界

鉴权将可信 `User{id,role,status}` 写入请求 context。业务函数从 context 读取 owner，禁止从 header/query/body 接受 owner。列表、搜索、计数与游标查询都含 owner 条件。带资源 ID 的路由统一通过资源归属守卫，先按 owner 和 ID 查表授权，再进入处理函数。资源归属不可变，因此处理函数可以在已授权 ID 上执行事务。访问不存在或他人实体统一 404。跨实体引用先检查归属，不能通过错误信息、导出或列表泄露他人对象。管理接口使用独立 admin 守卫，不能给普通业务查询增加 admin 绕过。

音频 Range/HEAD、原始音频、文本导出、句子深链接、任务 `retry` / `resolve`、说话人和人物关联均先检查 owner。游标中的 ID 和筛选条件不构成授权。请求层检查与复合外键共同防止遗漏关联检查。

共用服务商密钥时，HTTP 核对接口只能提交观察或确认该操作已登记的远端 ID。未知远端 ID 不能由任何 Web 账号直接绑定，否则会扩大跨账号读取边界。本机运维命令 `voices resolve-job <job-id> <operation-id> <remote-id>` 在人工核实归属后绑定，从 stdin 读取说明并记录审计。

后台调度仍可全局领取任务，这是内部受信边界。领取结果包含 owner，每次读取或写入业务链条都同时约束 job owner，服务商回包由内部 operation/job 映射归属，不能信任远端回传的 owner。全局 GC 可以清理各用户资源，但必须遵守既有引用、租约和不确定请求保护。

停用账号阻止新登录和新请求。已经接受的任务继续执行和清理，不能因停用中断远端核对或造成资源泄漏。本期不删除账号或内容，不承诺停用撤回已发送的 STT 请求。停用提交前已通过鉴权的在途请求允许完成。需要强制中断在途请求属于另一个契约。

## HTTP 与界面契约

- `GET /api/v1/auth/status` 公开返回 `initialized` 和 `registration_open`，不泄露用户数量、用户名或服务商秘密。
- `POST /api/v1/users` 接收 email、display_name、password。成功 201 返回用户摘要与新会话。后续注册关闭返回 403 `registration_closed`，重复邮箱 409 `email_taken`，角色等未知字段拒绝。
- `POST /api/v1/session` 接收 email、password。失败统一 401 `invalid_credentials`，包括不存在和停用账号。不存在账号使用固定 dummy bcrypt hash 比较以减少明显时序差异。
- `GET /api/v1/session` 返回当前 user（id、email、display_name、role）与既有 csrf_token、public_base_url、restore_mode。退出维持 DELETE。Cookie 的 HttpOnly/SameSite/HTTPS Secure、CSRF 与 Origin 校验保留。
- `PATCH /api/v1/me` 修改 display_name。`PUT /api/v1/me/password` 要求 current_password、new_password，成功 204 并清理所有会话和当前 Cookie。
- `GET /api/v1/admin/users` 为管理员提供分页账号摘要。`PATCH /api/v1/admin/users/{id}` 修改 role/status。`GET/PATCH /api/v1/admin/registration` 读写开关。写操作和审计同事务。失去管理员后实时拒绝管理请求。最后管理员保护返回 409 `last_admin`。
- 登录/注册按直接连接来源 IP 限速，登录另按规范化邮箱摘要限速，原始邮箱不进入桶键。反向代理场景不直接信任客户端伪造的 forwarded header。代理可信配置单独确定。注册限制每 IP 每分钟 5 次，登录每 IP 每分钟 20 次、每邮箱每分钟 10 次，返回 429 和 Retry-After。昂贵哈希前执行限速。
- 首次访问显示“创建管理员账号”。后续显示登录与允许时的注册入口。顶栏显示用户名称，个人设置提供修改密码。管理员额外显示账号管理和注册开关。所有授权以服务端为准。

RESTORE_MODE 下不允许注册和账号管理变更。已有用户登录、查看、退出和既有恢复核对保留，不允许新建账号绕过恢复保护。

## 迁移、配置与恢复

新增 `002_accounts.sql`，不改写已应用的 001。现有系统未正式交付且开发数据库预期没有业务内容。实施前实际查询录音、人物、blob、任务、settings 和幂等记录等持久表确认。若任何业务表非空，停止迁移并报告，不自动把未知数据交给首个注册用户，不清库，也不引入默认共享租户。迁移可清除无 user 的旧会话和登录限速桶，用户重新注册登录。

若存在需保留的业务数据，需先单独确定其合法归属、维护窗口和显式迁移操作，扩充设计后再实现。整项迁移在已有迁移锁与事务内执行。新旧版本不可同时运行。回滚用迁移前备份恢复，不能只回退应用二进制。

实现后去掉配置中的 ADMIN_PASSWORD_HASH、ADMIN_PASSWORD_HASH_FILE 和 DEV_LOGIN_PASSWORD 及其启动要求，不保留共享密码旁路。`hash-password` 不再作为部署步骤。DATABASE_URL、服务商密钥和监听地址仍由根目录 `.env` 提供。

忘记密码首版提供仅本机运维 CLI `voices reset-password <email>`：从 stdin 读取新密码，校验后更新哈希、撤销会话并记录审计，不改变 role/status，不输出秘密。不得暴露成无认证 HTTP 接口。邮件找回不在本期。

## 验收要求与实现顺序

先完成设计审查并更新 Feature / Use Case、OpenAPI、部署契约，再实现迁移和鉴权、逐项业务隔离、前端账号流程，最后完成真实 PostgreSQL 与浏览器验收。

1. 两个应用实例并发注册不同邮箱，恰好一个 admin。重复邮箱、事务失败不产生额外管理员或孤立会话。最后管理员保护在并发请求下保持。
2. A/B 登录后对每个业务端点、方法和他人 ID 做交叉访问。列表、搜索、分页、音频 Range、深链接、导出、任务操作与人物关联均不泄露、不修改他人数据。admin 访问 B 的业务内容同样 404。
3. A/B 上传同音频以及使用同一 Idempotency-Key 各自成功。各自重试保持去重和幂等。偏好互不影响。直接构造跨 owner 的数据库关联由复合外键拒绝。
4. 后台 prepare/transcribe/cleanup 使用真实数据库和核心实现，只 fake 外部 STT HTTP。验证任务接管、blob 归属和租约回收。不调用真实付费服务。
5. 改密码/停用使既有会话失效，角色变更即时影响管理接口。注册开关、CSRF、限速、非法字段和恢复模式均有针对性验证。
6. 全新库与现有空业务库迁移成功。非空业务库失败且事务不留下部分改动。重启无需管理员环境密码。现有业务测试改为真实注册取得账号与会话。
7. 浏览器实际完成首位注册、第二账号注册、登录、退出、改密码、管理员关闭注册。两用户分别上传和查看数据。

## 待收敛事项

已确定账号独立与首位管理员。首版采用邮箱登录、默认开放注册及实例共用 STT 额度。团队、邮箱验证、公开分享、个人服务商密钥、计费配额和账号删除均不包含在本方案。

## 实现边界补充

父实体 owner 派生使用 INSERT 触发器，所有拥有 owner 的实体拒绝 owner 变更。父子复合外键保留，业务入口统一守卫用于拒绝他人 ID，列表单独过滤。原始上传 blob 的 owner 来自会话 context；后台 blob 的 owner 来自已锁定的 job/recording。触发器不读取连接级用户变量，避免连接池身份串用。

## 邮箱登录修订

登录标识改为 email，trim 后转为小写，长度不超过 254 字节，须为单个合法邮箱地址。拒绝带显示名称、空白或多个地址的输入。邮箱唯一；界面的用户名是 display_name，1–100 字符、可重复。不保留 username 登录旁路，不把邮箱注册当作所有权验证。

新增 003 迁移，在 users 为空时移除旧 username 列，添加不可空唯一 email 列。已有账号时拒绝迁移，不伪造邮箱，不删除用户。UUID 与业务归属不变。公开 User 与注册/登录请求改用 email，运维密码重置按邮箱定位账号。

来源校验允许 PUBLIC_BASE_URL 的来源与显式 ALLOWED_ORIGINS 列表，仍拒绝 cross-site 请求。列表只接受完整 http/https origin，不允许通配符、路径、用户信息或任意 Host 推导。
