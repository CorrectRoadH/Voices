---
format: concord.document/v1
id: chat-local-edit-avatars-login
title: 聊天布局、局部编辑、头像与用户名登录
createdAt: 2026-10-18T04:08:38.864Z
kind: memory
memoryKind: note
state: captured
epoch: 0
promotions: []
history: []
---

已完成用户连续提出的交互改动：全局 useResource 同路径刷新保留旧内容，App 会话刷新保留 Shell；详情刷新保留正文节点/播放器且不反复深链接定位。片段正文点击原位编辑，仅 PATCH edited_text/revision，失败保留草稿；原完整编辑菜单仍可编辑时间等字段。
人物选择器两列网格、搜索 type=search/autocomplete=off/data-1p-ignore/data-lpignore，取消自动聚焦，密码管理器真实扩展效果未验证。人物页含只读内置人物，整卡链接详情；详情有编辑、自定义头像、标记/取消本人。005 本人字段同 owner 单一 true，事务替换与版本冲突回滚；006 PNG bytea 头像属性有尺寸/字节验证与规范化，GET 头像沿用 owner guard，null 清除。头像默认姓名首字，同有效人物连续消息组首姓名/组尾头像，紧凑左右气泡，窄屏调整。
正文使用 IntersectionObserver 双向滚动分页，按 ID 去重并保序；API 提供 current_cursor 维护窗口，重新拉取已加载范围；前插补偿位置，保留已加载 DOM。007 username 为可选唯一登录别名，不改变 user ID、密码、角色或会话；迁移唯一合法 display_name，注册可设置，个人资料可改；邮箱与用户名共享账号限流。旧 email 登录字段仍可用。普通局部扩展沿用原有 owner/认证边界；Herdr 当前真实 pane wH:p7K 仍 pane_not_found，未创建资源。
验证：scripts/test.sh 通过（Go tests/vet，21 前端单测、构建）；13 原 E2E 通过，加手机聊天/双向加载/原位保存测试通过；Go+PostgreSQL 完整浏览器 TestBrowserFullStack 通过含上传头像、姓名关联不重建播放器/片段节点、本人右侧、滚动追加、390px 无横向溢出；AccountsBrowserFullStack 通过且使用 BOB 用户名登录。新增 Go tests 覆盖本人替换/回滚、头像上传读取删除/跨账号拒绝、用户名邮箱共用身份与限流。首次 full-stack 错用旧 build 已重建；后两次失败为测试 capture 早于异步页面加载、内置卡片精确文本包含标记，修正后通过。concord check 通过。未提交/push，pane/tab/worktree 无残留。原 STT 日志费用需求仍未实现，独立审查阻塞不变。
