---
format: concord.document/v1
id: builtin-speakers
title: 内置人物与录音列表人物摘要
createdAt: 2026-10-18T03:44:19.044Z
kind: research
sources: []
---

# 内置人物与录音列表人物摘要

## 范围与兼容

在既有 owner 隔离与 person_id 关联契约内增加内置分类。已有普通人物、标签和片段的语义不变，既有 API 默认返回行为保留。新增字段与筛选均可独立停用，不改变权限边界或资源所有权，不迁移既有归属；按普通局部功能扩展处理，由主 agent 实现验收。

## 数据与生命周期

迁移 004 为 people 增加 builtin_key TEXT NULL，允许 background/music/system_prompt 三种非空值；普通人物为 NULL。每 owner/key 唯一，采用部分唯一索引。内置显示名称分别为背景声、音乐、系统提示音；不根据名称判断。

迁移为所有既有用户补齐三条人物；users AFTER INSERT 触发器为以后注册的用户在同事务创建。UUID 仍为每账号自己的 UUID；既有复合外键继续禁止跨账号关联。API 创建人物不能写 builtin_key，PATCH 内置人物返回 400 builtin_person_readonly；数据库触发器禁止改变 builtin_key，并禁止修改内置名称、备注和归档状态。内置项目不可由普通入口删除，系统当前没有人物删除 API。

不修改已有 speaker-labels 关联契约。多个标签可指向同一内置人物，当前版本这些标签的有效片段统一隐藏；显式改成未知或其它标签的片段按其有效人物判断。解除或改回普通人物立即恢复显示。保存与选择普通人物相同，使用版本检查，不删除文本或音频。

## 接口与界面

Person 增加 nullable builtin_key，Segment 增加 nullable person_builtin_key。GET people 默认不包含内置项，保持现有 API 调用方及筛选语义；显式 include_builtin=true 获取全部，人物管理页和详情页说话人选择器使用此参数。内置项在选择器优先显示并标记，不能编辑归档；同名普通人物仍有独立 UUID，不能被误判。

GET transcriptions/:id/segments 增加 hide_builtin=true，可选且默认 false。隐藏条件为有效 person 的 builtin_key IS NULL。服务端先筛选再分页，不能在前端过滤后留下整页空白。anchor_id 的窗口位置按筛选后目标之前的条数计算，保留原 ordinal 和稳定片段 ID。

正文默认发送 hide_builtin=true，提供显示背景声等片段的开关。打开具体句子深链接默认开启显示隐藏片段，确保原链接仍能定位。全文为空时显示没有可见片段并提供显示开关，不宣称转写没有数据。导出与原始文本 API 不受 UI 隐藏影响。单句播放范围保持该句 start_ms/end_ms，不受下一可见句影响。

Recording 增加 people 数组，元素仅 id/display_name。由当前 active_transcription_id 下片段的有效标签归属聚合，排除内置人物和明确未知归属，按人物 UUID 去重后按名称/id 排序。多个标签属于同一人物只显示一次；没有实际片段的标签不计入。GET recording、列表与导入响应使用相同投影，空名单返回 []。保持 owner 隔离及既有列表人物筛选逻辑，不扩大访问范围。录音行在日期下展示“人物：…”文本，溢出截断并可查看完整标题。

## 验收

真实数据库验证迁移已有用户与新注册均有三个隔离的内置项目，普通列表不出现内置项，修改与跨账号关联被拒绝。同名普通人物不隐藏。两个说话人关联背景声后所有相关片段默认隐藏；隐藏过滤后分页和 anchor 窗口正确；显式未知片段保留。勾选显示、深链接和导出仍可读取原文。录音人物摘要去重且随关联/版本激活变化，无内置项、无仅存在标签或历史版本的人物。浏览器验证选择内置项、隐藏恢复及列表人物显示。

## 本人标记与聊天阅读

people 增加 is_self BOOLEAN NOT NULL DEFAULT false，保持原有 owner/person_id 语义；同 owner 最多一条 true，部分唯一索引约束。内置人物不可成为本人。PATCH people 接受可选 is_self，设置 true 时在同事务内按 owner 加事务 advisory lock，清除该 owner 的旧本人并递增其 revision，再用请求 revision 更新目标；任何冲突回滚整个事务。false 只解除目标。归档不会删除本人身份，原片段仍按身份呈现；用户可另选普通人物替换。

人物页显式 include_builtin=true，内置卡片只读；普通人物提供标记本人/取消本人。本人标记不推断真实身份、不影响授权、标签关联或转写内容，仅控制聊天布局。页面本人片段右对齐，其余左对齐，保留按 ordinal 的 DOM 顺序。头像先使用姓名与稳定人物 ID 生成的彩色头像，同人物颜色一致；未知说话人按标签 ID 区分。此为既有模型的可回滚属性扩展，不改变持久数据原意、权限或资源所有权。

刷新同一资源保留当前内容，仅切换资源路径时清空；正文同一版本同一页的刷新保留节点、播放器与滚动位置，初次深链接才定位。文字点击原位编辑，仅提交 edited_text/revision，冲突保留草稿。

## 自定义头像

头像作为 people 的可选属性存于同一行 avatar_png BYTEA，最多 512 KiB，avatar_revision 仅在头像修改时递增。沿用人物所有权、事务与删除生命周期，不新增独立资源或外部文件存储。创建/修改人物可提交 avatar_data（PNG data URL），PATCH 的 null 清除，未提供时不改变。服务端先检查编码、字节数与 256×256 尺寸上限，再解码重编码 PNG，去掉元数据；拒绝 SVG 和其它未规范化格式。客户端接受常见图片、中心裁切成 256×256 PNG 后提交。

Person 返回 has_avatar、avatar_revision，不在列表内嵌图片。GET /people/:id/avatar 沿用人物鉴权与 owner 检查，返回 image/png、nosniff、no-store；不存在头像返回 404。内置人物仍不接受写改。默认头像显示姓名首字；连续有效人物相同的片段仅在组尾显示头像，组首显示姓名，各片段保留独立 ID、播放和编辑入口。

正文采用滚动自动加载，追加/前插后按 ordinal 保持时序并按片段 ID 去重，保留两端游标。前插时补偿当前首条消息位置；请求在途不重复加载。切换录音、版本或过滤时重新开始窗口。

## 用户名登录别名

既有认证仍由 user ID、原密码校验、账号状态与会话机制决定；用户名只扩展账号查询入口，不改变信任边界或授权。users 增加 nullable username TEXT，normalized lower(trim)、长度 2–32、无 @ 与空白，非空唯一。迁移只将合法且标准化后唯一的已有 display_name 补入；不为重复名称猜选账号。旧账号邮箱与密码保持可用，API 旧 email 字段继续支持；新登录可传 identifier，未提供时退回 email，含 @ 查 email，其余查 username。

注册可选 username；网页要求填写并同步为初始 display_name。PATCH me 可选 username（空串清除）并保留已有 display_name 更新。唯一冲突返回 username_taken；数据库唯一索引裁决并发。返回 User.username 空串表示未设置。用户名和邮箱命中同一 user ID 后共享 login_account 限流，未命中使用 identifier 限流并走 dummy bcrypt，保留 IP 限流与通用错误。此为可独立回滚的别名扩展，不迁移既有身份主键或所有权。
