# 手动价格管理退役审查

用户要求移除模型价格功能，禁止用户手动管理。主 agent 先提交方案，再通过 Herdr t1j0（父 t1gv，voices-price-retire-review，原生 Codex GPT-6.1 Sol / high）只读审查，初始任务随 CLI 启动，已读屏确认进入执行。结论无 P1/P2 阻塞；建议补充旧成功幂等记录重放仍拒绝，以及价格、审计和幂等数量不变的验证。已落实到真实 HTTP/PostgreSQL 测试。

审查者环境为只读，Concord 和通知命令受环境限制失败；父 agent 从终端读取完整报告，独立运行检查，不将审查结论当实现验收。t1j0 已 kill/rm 回收，无额外 pane/tab。现行契约见 docs/feature/stt-pricing/architecture.md。

核查现状：没有自动上游报价同步器；Soniox 官方 https://soniox.com/pricing 公布按小时与按 token 等计费，不能对任意兼容地址套用公开价。本轮关闭手工管理、不编造供应商实时价格。已有价格与费用快照保留；未来自动同步必须单独处理来源、版本和失败策略。

验收：隔离 PostgreSQL 上 `vp run check` 全部通过；`vp run test:ui` 三项真实浏览器测试通过（含 Markdown 安全渲染、375px 弹窗滚动与焦点恢复、任务详情、删除取消）；`TestSTTPricingBrowser` 通过，覆盖入口移除、旧路由跳转与历史汇总保留。`concord check` 通过。查看了手机更新日志截图。上游自动报价同步不在本轮交付内。
