---
format: concord.document/v1
id: import-edit-and-job-reentry
title: 导入收尾、页内编辑冲突与防重入核对
createdAt: 2026-10-18T03:33:20.832Z
kind: memory
memoryKind: note
state: captured
epoch: 0
promotions: []
history: []
---

用户连续反馈导入选项过多、导入完成仍停在弹窗、录音信息不应弹窗编辑且保存报冲突、任务页面疑似重入，并要求考虑服务器后台 STT 记录与价格。

完成：上传全批成功自动关闭并提示数量；失败保留原请求键重传；增加批次启动 ref 锁，上传中禁用等待项移除/编辑，防止连续点击和队列修改。上传高级选项折叠，使用个人保存配置或首个已配置服务商/模型；自动语言隐藏代码输入并移除长代码列表，保留显式外部费用同意。

录音信息改为详情页内编辑。保存只提交改过字段，以编辑开始时的快照比对；409 后读取最新版，只有所改字段未变化才按最新 revision 重试一次。同字段冲突保留草稿并明确提示；未改时间不再截断秒/毫秒或改写来源。后台预处理递增录音 revision 是普通编辑可能撞到冲突的机制来源。

任务展示将 polling 从等待转写改为等待服务商结果，attempt 从已尝试改为失败次数；恢复说明只在出现 uncertain/restore_hold 时显示。只读核对用户本次真实任务：upload/submit 各一条 known，lease_generation=1、attempt=0，随后 succeeded。没有重新提交远端请求，也没有调用额外付费 API。

验证：11 项 Playwright 场景通过；后追加连续双击导入断言及两个录音字段冲突场景再次 3 项通过。前端单元 21 项通过，build/typecheck 通过。真实 PostgreSQL 下跨实例幂等、远端不确定提交与晚到回执用例通过。真实全栈浏览器与账号全栈用例均通过，实际自动关闭后从列表进入详情。全栈日志出现一条 GET segments internal 错误，但浏览器用例和状态检查最终通过；是否是导航取消导致的日志尚未确认，未扩展为无关源码修复。

STT 费用设计在 docs/research/stt-operations-cost/README.md，链接 docs/README.md；未实施。设计区分按时长参考价估算与实际服务商账单，调用记录按 submit 意图唯一、价格不可变快照、管理员仅看跨用户运维元数据，不暴露音频或文字。属于新权限及持久化边界，必须独立评审。重新读取 Herdr skill/help 后验证真实环境，父 pane wH:p7K 仍 pane_not_found；未创建任何 worker 资源。已向用户提出本次是否豁免评审的异步问题，等待明确答复；不能把前次账号豁免扩大到本次。

无提交/push，无 pane/tab/worktree 残留；现有 Air/Vite/开发数据库未停止，未修改用户音频、账号或转写数据。
