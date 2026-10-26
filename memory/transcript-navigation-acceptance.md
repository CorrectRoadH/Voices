---
format: concord.document/v1
id: transcript-navigation-acceptance
title: 转写目录无闪烁导航与缓存验收
createdAt: 2026-10-26T08:48:51.328Z
kind: memory
memoryKind: note
state: captured
epoch: 0
promotions: []
history: []
---

本次调查发现正文数据 key 包含 anchor，目录点击还先行读取单句；一次已加载章节跳转产生单句、版本、同一句、窗口共四个读取请求，并把正文换成加载占位。

实现把录音/版本/人物筛选的数据归属与目标锚点分离。已加载目标直接定位；远处窗口请求期间保留已有正文，目录项展示加载且允许改选；AbortController 与请求对象身份共同拒绝迟到结果。复用版本信息，窗口响应同时提供目标片段和时间并校验归属，不再额外读单句。缓存最近四个不超过500句的连续窗口，不把不连续页面合并；刷新、版本、录音、筛选变更隔离旧缓存，改字同步缓存且不被较旧的在途响应覆盖。离开包含内置人物的引用窗口时恢复普通阅读过滤。播放器保留原节点，不自动播放。

实际验证：新增真实 Go/PostgreSQL/Chromium 导航回归，旧实现“已加载章节零读取”断言失败（实际4次）；新实现通过已加载目标/缓存窗口零读取、慢请求保留正文、取消旧定位、前进后退、失败保留正文、播放器不重建及不自动播放。截图已检查。五项窗口状态单测通过，覆盖并发结果、缓存编辑、失败保留、过滤恢复、有界缓存和版本隔离。全项目 TEST_DATABASE_URL=... vp run check 9/9通过；最后局部修订后的 web check、typecheck、状态测试和 build 均通过。Concord check 无 findings；CI分片覆盖14项正式E2E，新导航测试已加入完整入口与CI。

测试使用隔离 PostgreSQL 55439 和现有外部 STT fake，浏览器运行真实应用。旧搜索浏览器回归首次失败因测试用 panel.querySelector('.transcript-search') 读取已移出滚动区的搜索栏；已按真实布局修正可选高度计算，未放宽位置断言或等待时间。不存在生产部署、真实业务录音读取或新增后台协议改动。已有前端lint、bundle大小和CSP字体日志不在本次改动范围。

修正测试布局假设后，既有 TestTranscriptSearchBrowser 全流程通过（96.57秒），覆盖分页搜索、桌面/手机居中定位、高亮与片段播放。未运行全部长浏览器套件。本轮仅新增导航用例进入正式CI，不把局部浏览器通过描述为全量E2E通过。
