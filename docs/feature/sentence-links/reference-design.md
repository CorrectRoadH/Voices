# 短引用与多段选择设计

## 目标与边界

Obsidian 使用标准 Markdown 引用，每个片段输出 `[姓名：正文](https://host/base/q/code?at=2)`，第一段省略 at；段落之间空行，不附来源、录音名称或时间。不连续 ordinal 之间输出 `〔中间有省略〕`。正文按原顺序，Markdown 特殊字符转义。旧长链接继续有效。复制文本为当时快照，打开显示最新校正内容；引用成员不随人物修改或重转写变化。单次 1–100 段，限定同一转写版本，允许不同人物但逐段标名。无匿名分享。

## 数据与生命周期

新增 migration 016 创建 transcript_references，不存正文和人物快照。

| 字段 | 类型和约束 |
| --- | --- |
| code | text PRIMARY KEY，12 字符 crypto/rand base64url 随机码 |
| owner_id | uuid NOT NULL FK users，derive_owner 从转写推导，immutable_owner 禁止修改 |
| transcription_id | uuid NOT NULL；与 owner_id 组成 FK 指向 transcriptions(owner_id,id)，ON DELETE CASCADE |
| segment_ids | uuid[] NOT NULL，长度 1–100，无 NULL 元素 |
| created_at | timestamptz NOT NULL DEFAULT now() |

segment_ids 按 ordinal 升序且唯一。创建事务验证全部成员、版本与当前用户归属，录音行沿用 lockTranscription 排他锁，拒绝 deleting。

现有模型不支持独立删除片段，因此数组成员无需新增独立生命周期；未来独立删除片段须相应更新设计。读取校验所有成员仍存在，不静默返回残缺引用。

transcription_id 索引用于级联清理。删除录音的维护流程最终删除 transcription 时级联引用；deleting 即不可读取。随机码冲突 ON CONFLICT DO NOTHING 后重试，最多 5 次。

没有 TTL，不复用码。重复复制允许创建不同引用，不引入正文缓存或去重身份。

## API 与权限

POST /api/v1/transcriptions/{id}/references，body {segment_ids:string[]}，返回 201 {code,recording_id,transcription_id,segments:Segment[]}。沿用 protected、CSRF、restore mode 与 transcription owner gate；验证 UUID、1–100、无重复，否则 400 invalid_reference；缺失或异版本片段 400 invalid_reference，不泄露外部对象信息。服务端排序后存储并返回最新 Segment。

GET /api/v1/references/{code} 返回同样对象。code 使用独立命名参数避免 UUID gate，handler SQL 必须连接 transcriptions/recordings 并限定 recording.owner_id=UserID 和 state<>'deleting'；认证由 protected 执行。不存在、非法短码、其他用户的短码均 404。绝不把 code 当 bearer permission。

## 前端与交互

/q/:code 为受现有登录门控保护的 SPA 路由；解析后 replace 到历史版本页面，query ref=code&segment=目标ID。at 为 1 起始的整数，默认第一段；越界显示不可用，不猜测。Detail 查询 ref，核对 recording/transcription，显示已引用段数与上一段/下一段，当前窗口内引用成员有淡色标记，定位不自动播放。保留原文上下文与跨分页定位。新请求中止/过期响应不得覆盖新引用。

消息菜单“多选”进入模式并选中当前段；可点击正文或复选框切换，键盘操作可用，选择模式禁用正文编辑及人物修改。多选集合按 ID 管理，跨分页保留；切换录音/版本、隐藏内置人物或开始搜索清空多选。底部/正文顶部固定工具条显示已选数量、复制引用、取消；最多100段，失败保留选择，成功退出。复制链接也使用单段短码。复制进行中只对应操作显示 busy，禁用冲突操作；网络失败有 toast 与可见错误，剪贴板失败使用既有手动复制弹窗。新异步结果需有 scope/token guard，页面切换取消展示与复制。

“选择这组发言”快捷入口只在已加载窗口完整包含同人物连续组时提供；组首/组尾触及可继续加载边界时不提供，避免把部分组标成全部。以既有 isSpeakerContinuation 判定，超过100段则不提供。不扫描整份长录音。多选本身无加载窗口限制。

选择反馈由消息行承担：左侧独立圆形勾选框保持本人和他人消息对齐，整行可点击并高亮，键盘通过勾选框操作；不把选择控件塞入气泡元数据。Shift 点击按当前已加载消息顺序添加闭区间，隐藏或未加载消息不隐式选入，超过100段整次拒绝。进入/退出/切换范围重置范围选择起点。选择模式关闭单条菜单与原位编辑。

固定工具栏提供复制文字、复制引用、取消。桌面沿用正文上方固定区域；手机置于播放器上方并预留正文空间。文字与引用共用现有引用 API 获取有序的最新片段，文字输出省去 Markdown 链接，保留姓名与省略。不新增端点或持久化语义。只有剪贴板写入成功才清空选择；手动复制窗口关闭保留选择，显式取消退出。弹窗全选原文，提供再次复制按钮；异步重试也受现有 scope 和取消信号约束。

阅读正文默认不触发编辑；消息菜单“编辑文字”激活既有 InlineEdit，保持原位保存、取消及失败恢复。完整片段编辑仍使用原菜单入口。

## 取舍与验收

选择数据库短码而非压缩多个 UUID，链接长度与段数无关，跨实例持久化。新增持久化实体/API采用经独立原生 Codex GPT-6.1 Sol Review 核对的边界。现有 owner 边界不扩展。

验收：真实 PostgreSQL API 测试覆盖反序排序、非连续、多用户隔离、非法/混版本/重复/超限、正文修改后成员不变、删除失效与级联。

前端单测覆盖 Markdown 转义、省略、绝对 base prefix 与 at。

真实 Go/PostgreSQL/浏览器覆盖多选复制、短链登录返回、历史版本跨页定位及取消。运行 vp run check（隔离 TEST_DATABASE_URL），针对性浏览器验收；没有运行 Obsidian 客户端时明确报告，标准 Markdown 链接通过浏览器验证不冒充客户端验收。

## 审查结论与约束

独立审查确认：录音锁串行化引用创建与删除，现有片段生命周期允许数组存储，GET 必须显式限定 owner。接受建议：同步 Feature/Use Case 的旧长链接声明；测试创建与删除竞争、切换引用与复制 scope 失效；Markdown 转义覆盖星号、反引号、HTML/实体及 base 路径括号。Obsidian 客户端未运行时不得宣称客户端验收通过。
