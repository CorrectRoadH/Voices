---
format: concord.document/v1
id: frontend-loading-acceptance
title: 前端读取与分页优化验收
createdAt: 2026-10-26T09:34:34.391Z
kind: memory
memoryKind: note
state: captured
epoch: 0
promotions: []
history: []
---

# 前端读取与分页优化验收

2026-10-26，用户授权修正六类读取与交互问题并提交推送。行为契约见 docs/feature/appearance/README.md、docs/feature/transcription/use-case/transcribe.md、docs/feature/call-logs/use-case/inspect-calls.md；实现边界见 docs/architecture.md。

- request 合并调用方取消与 30 秒超时；不自动重试写入。useResource 区分首次加载和刷新，path 改变立即隔离数据，轮询隐藏暂停、前台恢复，不重叠请求，改变轮询频率不重新发起初始读取。
- 录音库、人物及任务使用同一分页 hook；筛选与游标绑定，同范围切换保留上一组并提示，失败明确仍显示旧结果。刷新从首页读取到已展示范围，原子替换，避免任务第一页状态冻结。人物详情更换对象立即隔离。
- 文字筛选 250ms 防抖；正文搜索清空后复用当前版本/revision 的完成结果，超过 20000 段或 8 MiB 文字估算时清空查询释放。首次搜索仍读取全文，不增加服务端搜索 API。
- 调用日志名称最多 4 并发，只补缺失 ID，500 项页面内缓存；刷新重新核对，endpoint 切换隔离。
- 阅读页任一资源有活跃任务时三类读取均保持 7 秒，稳定后降为 60 秒；后台不轮询，回到前台刷新。

## 证据与边界

- API 回归的相同测试在恢复旧 signal 选择表达式后 1 failed / 7 passed（请求无限等待导致 5 秒测试超时）；修复后 8/8 passed。命令：`vp -C web run test --run src/lib/api.test.ts`。临时恢复仅限本轮文件，现有修改已保留。
- 隔离 PostgreSQL 上 `TEST_DATABASE_URL=... vp run check` 9/9 成功，包含 Go 测试/vet、28 项 web 单测、10 项 worker 单测及构建。最后统一详情轮询间隔后，web check、typecheck 与根 build 再次通过。
- `TestLoadingBrowser` 最终 22.59 秒通过：真实 Go/PostgreSQL/Chromium、36 条录音筛选慢请求保留、失败保留与重试、旧游标不进入新筛选、第二页加载后刷新全部 55 条取消任务、只补取一个新录音名称、不重取已有名称、清空再搜索零重复下载、搜索跨页目标、稳定 7.5 秒无请求、隐藏 7.5 秒无请求及可见时刷新。最终脚本使用真实登录表单确定性操作，无模型调用。截图已检查。
- `TestTranscriptNavigationBrowser` 24.44 秒通过，保留原有目录缓存、慢请求、快速定位、失败保留与播放器生命周期断言。
- 既有 `TestTranscriptSearchBrowser` 本轮两次被测试模型服务 500 / Service temporarily unavailable 打断，不能记为通过。此前搜索定位部分断言通过，不代表整个旧用例通过；最终新增确定性搜索/缓存/跨页回归通过。没有运行全量自然语言 E2E。
- 测试期间系统 PostgreSQL 从 17.11 切到 18.6，运行中的测试进程从 /run/current-system 加载了不兼容 plpgsql 库。仅重启本轮隔离实例并固定 17.11 的 Nix store postgres 路径，验收恢复。未修改系统服务或生产数据库。
- Concord check findings=[]，分片脚本覆盖 15 项恰好一次，diff --check 通过；已有 lint 警告、bundle 体积提示和测试字体 CSP 日志仍存在。

未部署生产。没有创建 worker pane/tab/worktree；隔离数据库在交接前关闭。
