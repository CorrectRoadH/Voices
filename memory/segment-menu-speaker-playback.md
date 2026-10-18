---
format: concord.document/v1
id: segment-menu-speaker-playback
title: 片段菜单、批量人物关联与范围播放
createdAt: 2026-10-18T03:38:51.039Z
kind: memory
memoryKind: note
state: captured
epoch: 0
promotions: []
history: []
---

用户要求每句底部动作移至右上角更多菜单，点击说话人选择或新建人物并批量更新；点击右侧播放后上方播放器自动播放到下一句结束。

已实现官方 shadcn Base UI dropdown-menu/popover。每句菜单保留复制引用、链接、编辑。SpeakerPicker 使用既有 speaker-labels PATCH 契约关联当前版本标签，后端动态联查使该标签全部片段（含分页外片段）更新；不按名称合并标签，不改其他版本或明确未知归属。新人物创建复用幂等键，创建成功但关联失败时保留创建结果，提交 ref 防连续点击。

播放从点击片段 start_ms 开始，到下一片段 end_ms 暂停并钳制时间；跨分页使用下一游标 limit=1 获取边界，最后一句退回自身 end_ms。无有效时间拒绝；快速切换请求用代数隔离，换版本/卸载停止；暂停后原生播放器可继续普通播放。深链接仍不自动播放。

验证：pnpm --dir web build/typecheck 通过；系统 Chromium 下 pnpm --dir web test:e2e 13 项通过，包含真实 audio 同页及跨页播放到 2.6 秒暂停、无时间戳与更多菜单编辑复制。VOICES_BROWSER_TEST=1 go test ./internal/app -run TestBrowserFullStack -count=1 -v 通过，真实 Go/PG 验证选择现有人物、新建并关联人物以及同标签多条片段整体更新。最后的布局截断、提交锁与跨页归属校验补丁经 build/typecheck 检查通过。Concord check 通过。full-stack 仍出现一次导航期间 GET segments internal 日志但流程通过，未定位具体原因；此前记录同类观察。

没有触碰用户实际音频/人物数据，没有调用额外真实付费接口。无提交/push，无新 pane/tab/worktree；用户现有开发服务继续运行。STT 后台费用方案仍等待独立评审或用户明确豁免，未自动扩大前次豁免。
