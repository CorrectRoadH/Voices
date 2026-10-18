---
format: concord.document/v1
id: group-chat-clock
title: 群聊布局、人物选择与真实时间校准
createdAt: 2026-10-18T05:32:02.426Z
kind: memory
memoryKind: note
state: captured
epoch: 0
promotions: []
history: []
---

根据用户提供的 Telegram 群聊截图，阅读区改为统一左侧气泡，姓名沿用连续人物分组，修复 PopoverTrigger 覆盖 data-slot 导致姓名紧凑样式未命中的问题。头像及消息菜单编辑下方的更换人物共用 SpeakerPicker，候选带头像，仍按既有契约更新当前标签全部片段。无标签时不伪造关联。内联编辑保留接近气泡宽度，单行起自动高度，小图标保存与取消。

录音开始时间复用 recorded_at 与现有 PATCH/revision 冲突处理；校准按浏览器时区到秒。消息展示 recorded_at + start_ms，跨日显示日期分隔，导入时间明确提醒待校准；播放仍使用 start_ms/end_ms，校准不重建播放器。

验证：pnpm --dir web build 成功。原 15 项 Playwright 用例通过；新增头像/菜单换人、紧凑编辑、跨日与秒级校准用例单独通过（修复候选按钮无障碍名后验证）。CGO_ENABLED=0 VOICES_BROWSER_TEST=1 go test ./internal/app -run '^TestBrowserFullStack$' -count=1 -v 在本地 PostgreSQL 隔离 schema 通过，含真实 HTTP 保存校准及播放器 DOM 保留。concord check 和 git diff --check 通过。截图 /tmp/voices-chat-mobile.png、/tmp/voices-chat-edit.png。无 worker 或 pane/tab/worktree；保留用户开发服务，未提交或 push。
