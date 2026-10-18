---
format: concord.document/v1
id: floating-player-outline-noop
title: 浮动播放器、时间目录与无变化编辑
createdAt: 2026-10-18T05:38:09.204Z
kind: memory
memoryKind: note
state: captured
epoch: 0
promotions: []
history: []
---

用户纠正群聊参考范围：本人仍需靠右，恢复基于 is_self 的反向行和绿色气泡，同时将本人更多按钮放到左外侧。气泡只显示播放图标，真实时刻保留悬停提示。

原位编辑草稿记录进入编辑时的原文字串；完全未变或改后撤回均退出而不 PATCH。完整编辑无变化也退出，仅时间或归属变化时不提交 edited_text。edited_text 与 source_text 相同的历史片段隐藏校正标记，不改历史数据。

播放器固定在窗口底部，移动端适配安全区，正文与通知避开播放器。桌面右侧目录随滚动保持可见；小屏和桌面播放器可打开目录弹层。目录按已加载正文每分钟的首句生成，明确标注范围，随双向加载更新；目录跳转只滚动已加载正文，不自动播放或重建 audio。

验证：前端 build 成功；18 项 Playwright 用例全部通过（17 项整套运行、新增无变化测试修正按钮选择器后单独通过）。真实 Go HTTP + PostgreSQL 隔离 schema 的 TestBrowserFullStack 通过，包括本人右侧、校准保存、编辑、人物、导出及播放。播放器桌面和手机位置截图已检查。concord check、git diff --check 通过。无 pane/tab/worktree；保留用户开发进程，未提交、push 或部署。
