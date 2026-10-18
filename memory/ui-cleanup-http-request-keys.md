---
format: concord.document/v1
id: ui-cleanup-http-request-keys
title: 界面精简与 HTTP 请求键修复
createdAt: 2026-10-18T03:23:02.328Z
kind: memory
memoryKind: note
state: captured
epoch: 0
promotions: []
history: []
---

按用户要求删除录音库介绍卡、页面英文眉题和宣传说明、顶栏假面包屑、页脚口号以及重复账号展示。个人资料入口收拢到侧栏底部用户名/邮箱；个人转写偏好留在主导航，管理员账号管理另列服务器管理分组。保留错误、字段、费用和恢复状态提示；未变更权限边界和后台模型。

HTTP 局域网浏览器没有 crypto.randomUUID，导致上传弹窗崩溃。所有上传、人物、转写的请求键调用统一改为 requestKey，使用 getRandomValues 生成 UUID v4；保留重试键生命周期。浏览器测试统一禁用 randomUUID，覆盖真实 XHR 上传与失败重传复用键、转写新建、移动导航等九个场景，全部通过。

验证：pnpm --dir web test 21 项通过；pnpm --dir web build 含 typecheck 通过；PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/run/current-system/sw/bin/chromium pnpm --dir web test:e2e 9 项通过；concord check 通过。默认 Playwright 缓存浏览器缺少 libglib，改用系统 Chromium 后完成验证。移动端截图已检查，无横向溢出。未操作用户账号与业务数据、未提交/push，无新 pane/tab/worktree；用户 Air/Vite/数据库继续运行。
