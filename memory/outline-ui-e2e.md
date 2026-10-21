---
format: concord.document/v1
id: outline-ui-e2e
title: 目录内重试与中文 e2e 迁移验收
createdAt: 2026-10-19T07:28:34.951Z
kind: memory
memoryKind: note
state: captured
epoch: 0
promotions: []
history: []
---

# 目录界面与中文 e2e 迁移

2026-10-19 用户明确要求移除录音详情顶部的“AI 摘要与主题目录”卡片，生成、失败状态和重试直接放在目录区域；摘要在成功目录内展开查看。桌面侧栏和播放器目录共用组件，没有转写时提示完成转写，保留灰色费用说明。

用户指定 tester-army/e2e，要求不再保留已有 Playwright 测试，并用中文写用例。采用 e2e 0.21.2 与 @e2e-dev/web 0.15.2，删除 Playwright runner、两份模拟业务 API 的 spec 和七份独立脚本。七个中文真实浏览器流程迁入 web/tests，沿用 Go/隔离 PostgreSQL fixture，仅模拟外部 STT、LLM 和更新服务。

保留权限、并发、幂等、取消、协议、安全跳转、HTTP 与翻译完整性测试。删除了由生成入口 HTTP 测试覆盖的直接 Validate 重复断言；未把所有单元测试笼统删除。界面回归中无变化正文不发送保存、未配置模型不生成，继续通过真实浏览器验证。

入口为 TEST_DATABASE_URL=... pnpm test:e2e；可用 E2E_CHROMIUM_EXECUTABLE_PATH 指定系统 Chromium。CI 安装 e2e-web Chromium，失败时上传 web/.e2e 隐藏目录。SDK 的精确匹配与密码字段保护按原生接口使用；模型下拉打开时通过 placeholder 定位，Escape 关闭。系统 Chromium profile 清理为短暂的文件占用提供有界重试。

验证：隔离 PostgreSQL 的 scripts/test.sh 通过，统一 test:e2e 的七个流程通过，API 类型生成无 diff，actionlint 与 Concord 检查通过。未提交、push、部署或调用真实付费模型。

用户提供的真实日志为 invalid_response/unknown_segment：模型引用了不存在的输入片段。已增加受控诊断日志，未放宽锚点校验，也未宣称模型输出问题已修复。
