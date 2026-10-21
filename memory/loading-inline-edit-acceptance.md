---
format: concord.document/v1
id: loading-inline-edit-acceptance
title: 全站加载反馈与行内编辑验收
createdAt: 2026-10-21T11:21:55.619Z
kind: memory
memoryKind: note
state: captured
epoch: 0
promotions: []
history: []
---

统一页面加载状态、按钮等待反馈和标题、日期、备注、片段的行内编辑。草稿在请求失败与版本冲突后保留；提交去重并区分同字段冲突与其他字段更新，中文输入法确认不误提交。转写准备及处理阶段展示进度。

真实 PostgreSQL、Go HTTP 与 Chromium 验收覆盖加载、键盘操作、请求中状态、真实并发冲突、移动端和播放器保留。发现冲突后焦点丢失，已修复并通过回归。测试隔离数据库，语音服务边界使用 fixture，不调用付费模型或生产环境。

补充修复隐藏内置系统片段后的聊天分组：只有原始 ordinal 相邻、同一有效人物且同一本地日期才连续分组；首尾头像可见。浏览器回归先复现第二位说话人头像隐藏，再验证修复后头像和隐藏空档后的姓名可见。编辑当前片段与批量关联说话人明确区分，不推断或改动用户录音中的真实归属。

vp run check、vp run test:ui、补充修复后的 vp run check:web 与 concord check 均通过。现有 Web 15 项与 Worker 4 项 lint 警告仍保留；浏览器有既有字体 CSP 提示。未部署。
