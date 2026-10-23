---
format: concord.document/v1
id: obsidian-short-references
title: Obsidian 短引用与多段选择验收
createdAt: 2026-10-23T08:23:34.608Z
kind: memory
memoryKind: note
state: captured
epoch: 0
promotions: []
history: []
---

# Obsidian 短引用与多段选择验收

用户指定引用用于 Obsidian，点击文字可跳回 Voices，并明确不附来源行。行为与实现约束由 [引用契约](../docs/feature/sentence-links/README.md) 和 [设计](../docs/feature/sentence-links/reference-design.md) 拥有。

主 agent 先调查权限、片段分页、录音删除和数据库归属约束，再通过 Herdr 启动原生 Codex / GPT-6.1 Sol high 的 voices-ref-review 独立审查。结论为可实施，无阻塞项；接受建议补齐契约、异步取消、删除竞争及 Markdown 特殊字符测试。Review 只读，pane 已回收。实现保留现有 derive_owner、immutable_owner 与复合归属外键。

## 验证

全部命令使用独立 PostgreSQL 数据库，fixture 自建并清理独立 schema。

- `vp run check`：最终 9/9 成功，包含 Go/数据库测试、Go vet、前端与 Worker 静态检查、测试和前端构建。前端 17 项、Worker 10 项通过；原有 lint 与包体积警告仍在。
- `vp run test:references`：真实 Go/PostgreSQL/Chromium 通过。正式验收文件为 `web/tests/references.e2e.ts`，正常用户操作使用中文 agent.act 和配置的 gpt-6.1-sol；31 次模型调用，约 234 秒。验证连续组选中、跨页多选、Markdown、省略标记、校正文、登录回到所点段、引用导航、手机工具条、非法位置、复制失败/取消和旧长链接。
- `vp run test:ui`：原有长按、菜单、行内编辑、并发与移动端交互回归通过，约 20 秒。
- `concord check --json`、`git diff --check`、`python3 scripts/check-e2e-shards.py` 通过。默认 E2E 入口和三个 CI 分片恰好覆盖 12 个 Go 场景。
- `vp -C web run generate:api`：输出与工作区生成文件字节一致。

数据库边界测试涵盖其他账号和匿名拒绝、CSRF、恢复模式、非法/重复/超限/跨版本片段、原文顺序、跨实例读取、创建与删除竞争、删除失效和级联清理。删除回收器每轮只清理一个远端资源，引用在录音标记 deleting 时立即不可读，完成多轮清理后随转写删除。

## 验收边界

未运行 Obsidian 客户端；标准 Markdown 输出及浏览器跳转通过，不声称客户端验收。没有发布或部署，也没有运行全量付费模型 E2E、Docker 构建或 workerd（本次未改相关运行时代码）。actionlint 未安装，CI 改动为场景筛选列表并已通过分片一致性脚本。

浏览器有既有 data: 字体 CSP 日志，未在本次扩大范围修复。桌面和手机截图位于 `web/.e2e/references/`；手机引用工具条可见，目标位于工具条与播放器之间。
