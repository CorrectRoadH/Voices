---
format: concord.document/v1
id: transcript-shared-read-acceptance
title: 转写共享读取与搜索验收
createdAt: 2026-10-28T10:10:27.550Z
kind: memory
memoryKind: note
state: captured
epoch: 0
promotions: []
history: []
---

# 转写共享读取与搜索验收

2026-10-28，用户要求搜索、目录、滚动共用分页转写数据，并优化输入卡顿、增加高亮下拉结果，完成后提交并 push。

设计位于 docs/feature/transcription/architecture.md。Herdr 注入的父 pane w4W:p46 已不存在，pane current/layout 均返回 pane_not_found；用户明确授权本次由主 agent 自审后实施。没有启动替代 worker，也没有创建 pane/tab/worktree。

自审收敛：缓存所有者限定为当前阅读页及转写版本，不使用模块全局单例；原始分页统一读取未过滤数据，人物隐藏只投影；游标来自服务端，不从稀疏片段推断连续性；请求由 store 拥有，取消一个消费者不终止共用请求；页面销毁取消并清理，代次检查拒绝迟到响应；编辑按 revision 保护。搜索仍需遍历全版本，缓存内存随正文长度增加，未声明固定内存上限。

源码确认的查询重置原因：录音路由和转写路由给 DetailPage 不同 key，同版本定位跳路由会重建详情页。搜索与目录改为更新当前路由 segment 参数，保留查询、正文和播放器。输入草稿局部维护，150ms后发布查询，IME组合不发布；候选结果保留原查询文字，支持高亮、上下文、分批展开和键盘导航。Base UI组合框对键盘的默认处理需用 preventBaseUIHandler 阻止重复执行；“显示更多结果”操作后焦点回到输入框。

验证使用本轮创建的隔离 PostgreSQL 数据库。vp run check 全部通过，前端36项测试、Go集成、worker、release、vet与构建通过；vp run check:web 通过，有既有 lint warnings 和 bundle size 提示。concord check 通过。

真实 Go/PostgreSQL/系统 Chromium 运行 vp run test:transcript，搜索和目录两条浏览器用例通过。测试包括：滚动读取前两页后，搜索仅补最后一页；下一处无新增请求且保持audio DOM及查询；IME组合期间250ms正文零mutation/零搜索请求；鼠标及方向键/Enter/Shift+Enter选择；30→60条展开与Escape关闭/清除；大小写及正则符号字面匹配；前进后退、慢响应、失败保留正文、向前补载保持位置；390px手机下拉可见无溢出，并检查桌面浅色/手机深色截图。首次官方Chromium因Nix动态库缺失启动失败，使用仓库既有 E2E_CHROMIUM_EXECUTABLE_PATH=/run/current-system/sw/bin/chromium 入口完成。未测用户生产数据的绝对输入延迟，未部署。
