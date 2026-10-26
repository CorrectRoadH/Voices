# 站点 OIDC 登录设计

行为 owner：[统一身份登录与账号绑定](use-case/oidc-login.md)。本方案新增外部身份信任边界，须独立 Codex Review 后实现；审查结论在本文末维护。

## 范围与取舍

站点配置一个通用 OIDC provider，使用 Discovery、Authorization Code、PKCE S256 和 confidential client secret。支持标准 OIDC 的身份平台，不把只有 OAuth2、没有 ID Token 的厂商专用用户接口视为通用兼容。保留本地密码登录和 operator reset-password；不实现第三方 API 授权、多个 provider、组/角色自动映射、上游单点登出。配置即时从 PostgreSQL 读取，跨实例有效，不修改 App.Config 共享状态。

## 持久化与所有权

新增 oidc_settings 单例。字段：id smallint PK CHECK=1；enabled boolean 默认 false；display_name text 默认 统一登录。issuer_url/client_id/client_secret 为 text，默认空；revision bigint 默认1；updated_at timestamptz。

管理员写入带修订号，事务锁 admin 和配置行，审计只记录变更字段，密钥读取仅返回 client_secret_configured。空输入由 UI 省略以保留；明确传空串清除。

启用必须有合法 issuer、client ID、secret。修改 issuer/client ID 且已有 secret 时须显式提供替换或清除，防止旧凭据发到新目标。管理员可以保存未启用的配置草稿。配置变化增加 revision，使在途登录失效。

新增 user_oidc_identities（issuer text、subject text，复合主键；user_id uuid NOT NULL FK users ON DELETE CASCADE；created_at timestamptz；UNIQUE(user_id,issuer)）。subject 必须为 1–255 个 ASCII 字符，保持原值与大小写，验证层和数据库 CHECK 同时约束。身份只由验证后的 iss+sub 定位；邮箱变化不更改既有账号邮箱和数据归属。更换站点 issuer 保留旧关联，切回原 issuer 可恢复，不按邮箱迁移关联。

users.password_hash 改为可空，NULL 表示没有本地密码。现有行和值不变。密码登录对 NULL 使用 dummy bcrypt 并拒绝；已登录无密码用户可设置首个密码，有密码时仍要求旧密码，在用户锁后再次锁定并验证原会话仍有效、账号 active，成功撤销全部会话。operator reset-password 仍能恢复任意账号。User API 增加 has_password，所有输出一致。

新增 oidc_login_flows，字段如下：

- state_hash text PK；browser_hash、nonce_hash、pkce_verifier 为 text NOT NULL。
- settings_revision bigint；redirect_uri text；purpose text CHECK login/link。
- user_id uuid nullable FK users CASCADE；session_hash text nullable；expires_at timestamptz。

link 必须有 user_id/session_hash，login 无。过期索引 expires_at，10分钟有效。仅短期 verifier 必须可读；state/browser/nonce 仅存哈希。不持久化 ID/access/refresh tokens。维护任务删除过期 flow，开始登录也清理过期记录。

## HTTP 与登录生命周期

- GET /api/v1/auth/status 扩展 oidc_enabled、oidc_display_name，仅在 bootstrap 和 site setup 完成且 provider 启用时提供入口。
- GET/PATCH /api/v1/admin/oidc：管理员权限、CSRF、恢复模式写保护；响应安全配置、revision 和当前实例有效 PublicBaseURL 推导的 redirect_uri；PATCH 只接受已声明字段和 revision。
- POST /api/v1/auth/oidc/start：JSON {}，现有 origin 检查与 IP 限流，读取启用配置与初始化状态；创建 flow 后返回 authorization_url；设置随机 voices_oidc_flow cookie。Cookie 使用 HttpOnly、SameSite=Lax、HTTPS 时 Secure、本站子路径、MaxAge 600。不接受 return URL。保留正式会话 Strict Cookie。
- POST /api/v1/me/oidc：认证+CSRF，绑定开始，保存当前 session hash/user id；复用流程，prompt=login。GET 同一路径返回当前 provider 名称、是否启用/已绑定、has_password，不返回 subject。DELETE 要求本地密码存在，按当前 issuer 解绑，撤销账号全部会话并退出。
- GET /api/v1/auth/oidc/callback：仅 query code/state，使用浏览器 flow cookie + state 原子 DELETE RETURNING 消费未过期 flow，包括取消时。回调不依赖 Strict session cookie；拒绝缺失/错误绑定、重复参数、重放和配置修订变化。交换 code 时使用保存的 redirect_uri/verifier，验证签名、issuer、audience、expiry、nonce，必要时检查 azp。失败不泄露 provider 错误或令牌，303 重定向本站根路径 ?oidc_error=<固定错误码>；绑定结果到 /account。成功登录签发现有会话 cookie，303 到本站根路径。

网络请求在事务外，使用成熟 go-oidc 与 oauth2 库；有总超时、响应大小上限且禁用 HTTP 重定向。回调站点地址和 issuer/discovery endpoint/auth/token/JWKS 均要求 HTTPS，只有 loopback HTTP 用于本地开发；URL 禁止 userinfo、fragment，issuer 另外禁止 query。管理员配置的内部 HTTPS 身份平台属于站点管理员的出站信任范围，不给匿名用户自选 issuer。client secret 只送给可信 Discovery 中的 token endpoint。

数据库最终事务按 instance_settings → oidc_settings → user → session 加锁，与 lockAdmin 的现有顺序一致；确认当前配置仍同 revision/启用，再完成身份解析、建号/绑定与 insertSession。禁用、密码变更与既有 user 行锁序列化。并发身份首次登录通过 instance_settings 行锁序列化账号/身份创建；unique 约束拒绝重复身份，失败不留下孤立用户。不跨网络持有数据库锁。

请求 scopes 固定为 openid email profile。ID Token 缺少建号所需声明时，从已校验 Discovery 的 UserInfo endpoint 获取；严格核对 sub 与 ID Token 一致。邮箱与 email_verified 必须来自同一声明集合，不混用；access token 仅驻留本次请求内存。UserInfo 使用同样的 URL、超时与响应上限约束。

已有身份只允许 active 用户登录，注册关闭不阻断已有绑定用户。未绑定身份必须提供有效且 email_verified=true 的邮箱才能建号；若邮箱已有账号，返回 account_exists 提示先用原方式登录并主动绑定，绝不自动合并。自动创建用户仅在完成初始化、允许注册且非恢复模式，固定 user 角色、无用户名、默认 zh-CN，name 合法时使用 name，否则将邮箱按 rune 截到100字符作为显示名称。首位 admin 仍只能本地注册。已存在身份无需持续提供邮箱即可登录。

link 最终事务在 user 锁后锁定 flow 记录的原 session，并验证 session 仍有效、账号 active；同身份绑定他人或本账号已有不同 subject 都拒绝，重复绑定自身同身份幂等；不按邮箱要求匹配。绑定不改邮箱、密码、角色，不创建或替换本地会话。恢复模式禁止绑定/解绑/建号，可允许已绑定账号登录。

## UI 与 API 文档

登录页保留密码表单，初始化完成且启用后显示“使用 {名称} 登录”；异步失败保留表单、显示 toast 和固定错误说明。账号页显示统一登录绑定状态和绑定/解绑动作；无密码时隐藏旧密码字段并明确设置密码；解绑有退出后果说明。

服务器设置增加独立统一登录卡片（onboarding 不展示），使用现有 Field/Card/Input/Switch/Button。按现有约定 800ms 自动保存、blur flush、串行修订、输入中允许继续编辑、失败保留草稿与重试、IME 不提交。未启用时可以保存草稿；启用字段齐全才保存，显示回调 URL 和密钥留空保留/明确清除。OIDC 有独立 revision，不与 STT/LLM 自动保存互相冲突。文案双语维护；OpenAPI 为新端点/响应字段和错误的唯一接口契约，重新生成 TS 类型。

## 验收

使用真实 PostgreSQL 与本地测试 OIDC provider。测试平台提供独立 RSA/JWKS 和授权码/PKCE/token HTTP 流程，fake 仅模拟外部 IdP。验证：管理员/普通用户权限、secret 不回显、修订冲突与目标变更、首次建号和再次登录、禁用、注册关闭、邮箱冲突、无验证邮箱。还须覆盖 iss/aud/nonce/签名/过期拒绝、state/cookie/重放、配置中途变化、多实例回调。账号生命周期覆盖绑定与解绑、密码设置与撤销、恢复模式、子路径回调。

真实浏览器覆盖管理员配置、登录跳转、账号绑定和设置密码的可观察行为。运行 vp run check 和 vp run test:e2e，使用独立 TEST_DATABASE_URL；Concord check/trace 是关系验证而非测试覆盖。

## 独立审查

原生 Codex / GPT-6.1 Sol 已独立审查。主 agent 采纳并收敛以下修订：

- 缺失/空/超长 subject 在身份查询前拒绝，数据库也添加 CHECK，防止多个无 subject 用户共享账号。
- 支持标准 UserInfo 邮箱获取，要求 subject 一致且邮箱/验证标志来自同一集合。
- 显示名称回退按 rune 截断，满足现有100字符约束。
- 锁顺序对齐现有 lockAdmin；持有用户锁后重新核对身份关联，避免解绑竞态。

审查未发现其余设计阻塞；以上修订对应的攻击输入、UserInfo 和长邮箱均纳入验证。浏览器 Cookie 行为仍须真实验收，不以协议判断替代。

## 部署与回退

迁移新增三张表，并允许 password_hash 为 NULL，不改变已有用户 ID、密码值和资源归属。先更新全部应用副本，再启用统一登录，避免旧副本遇到无密码用户时按旧模型读取失败。

关闭统一登录保留身份关联和本站会话，不删除用户或业务数据。回退至不支持无密码账号的旧程序前，需要让相关用户设置本地密码，或由操作员执行既有 reset-password；不能把只回退二进制视为完整数据回退。
