---
format: concord.document/v1
id: interface-localization
title: 用户级界面国际化
createdAt: 2026-10-19T03:54:14.800Z
kind: research
sources: []
---

# 用户级界面国际化

## 目标与范围

首批支持简体中文 zh-CN 与英文 en，覆盖登录、导航、录音库、详情与播放器、上传、人物、任务、个人账号、转写偏好、服务器配置、管理概览与日志的界面文案、可访问名称、通知、状态和日期。浏览器标题保持 Voices。界面语言不改变转写语言、录音内容、人物名、摘要或目录。后台原始日志、用户内容及服务商标识不翻译。

## 当前证据

web/package.json 尚无国际化库，web/src/lib/format.ts 使用固定 zh-CN；文案分散在 pages、components、lib。internal/app/auth.go 的 User 和 session 响应没有语言偏好。internal/app/accounts.go 的 PATCH /me 要求 display_name，内部 settings defaults 对象属于转写配置且整体覆盖，不能把界面语言混入该对象。既有 users 主键及会话、所有权边界保持不变。

## 持久化与接口

在 users 增加 ui_language text NOT NULL DEFAULT 'zh-CN'，CHECK 仅允许 zh-CN/en，迁移文件 011_user_language.sql；已有账号保持简体中文。无新表、外键、索引或后台资源。偏好与账号同生命周期，备份恢复自然保留，不重新解释既有数据。新增列的默认值允许旧版本继续创建账号，旧代码更新既有列不会清除偏好。

User JSON 增加 ui_language，注册、登录、会话、个人资料更新及管理员用户查询均返回真实值。PATCH /me 增加可选 ui_language，display_name 改为可选但提供时继续使用既有验证；username 语义不变。仅更新明确提供的字段并使用 UPDATE RETURNING 返回最新 User，避免语言切换覆盖姓名或用户名。无更新字段与 null/未知语言拒绝 400；语言枚举错误代码 invalid_ui_language。沿用登录、CSRF、来源和恢复模式权限，无跨用户操作。语言偏好使用同字段最后一次成功写入生效，不新增修订模型。OpenAPI 与生成的前端类型同步。

## 前端与翻译

使用 i18next + react-i18next，随构建携带 zh-CN/en 字典，不在线翻译。中文源文案用作完整资源键，关闭 keySeparator/nsSeparator，动态参数使用 interpolation；英文资源须完整且可检查。React 通过 languageChanged 订阅更新，不 remount 工作台，不丢失表单、播放或滚动状态。工具函数通过同一实例翻译；模块初始化阶段不缓存已翻译标签。日期使用当前界面 locale，数字/数量句子采用参数插值，不拼接英文语序。

语言入口放在我的账号外观设置及未登录页，选项文字始终为简体中文 / English。登录前默认 zh-CN，可在当前浏览器保存访客语言选择；读取失败使用 zh-CN。登录后以服务端 User.ui_language 为准，禁止使用上一个账号的缓存替代。账号切换先采用目标账号语言再显示工作台；退出或失效恢复访客语言。账号语言保存成功后即时切换，失败保持原语言并保留可重试控件，保存期间禁止重复切换。多标签页不承诺即时同步，刷新/重新登录读取服务端最新偏好。恢复模式可查看但禁止账号偏好写入。

注册请求携带注册页明确选择的 ui_language，成功后该值成为新账号初始偏好；API 未提供时默认 zh-CN，提供 null 或非法值拒绝。登录现有账号不携带也不覆盖账号语言。

API 保持原有 code/message/request_id 契约。前端对已知受控错误文案及 code 本地化；未知错误在英文中显示通用失败说明与 code/request ID，不能把任意服务器原文或用户内容当成翻译键输出。网络、冲突、认证、导出与上传错误完整本地化。已有错误提示在切换语言时可保留发生时文案，新的错误与通知使用当前语言。内置人物类别按 builtin_key 显示翻译，普通人物名原样保留。

## 验收

隔离 PostgreSQL 验证迁移默认值、两个账号独立偏好、登录会话和管理员查询、非法值/null 拒绝、语言-only 更新保留资料、资料-only 更新保留语言、并发独立字段更新、恢复模式与CSRF。真实浏览器验证访客选择、账号语言保存/重登/新浏览器、账号隔离、失败不切换、页面切换无重启；英文桌面与窄屏/深色覆盖主入口、上传失败、自动保存失败、模型列表错误、日期、用户中文内容不翻译。字典完整性检查、类型/构建、现有中文回归、Go 检查与 Concord 校验。

## 审查结论

用户明确豁免本次独立审查，由主 agent 复核并实现。主 agent 复核重点：新增列默认值保留现有行为；PATCH 仅更新显式字段并返回真实状态，禁止将语言偏好混入整体覆盖的转写 defaults；会话以目标账号语言为准，访客缓存不覆盖登录账号；切换语言不 remount；未知服务端错误使用受控后备消息。上述约束纳入实现与验收。
