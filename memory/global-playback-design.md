# 全局播放设计审查

2026-11-14，按用户要求将录音播放从详情页提升到登录会话。方案归 [转写架构](../docs/feature/transcription/architecture.md)，行为归 [阅读与回放](../docs/feature/transcription/use-case/read-transcript.md#global-playback)。

Herdr 独立原生 Codex / GPT-6.1 Sol Review 静态审查通过，无阻塞设计问题；审查进程只读，Concord 锁文件操作受限，结构检查由主进程执行。

落地约束：控制器不再按页面或版本 key 重置；切源同步取消旧请求和单句边界后更新 src。正文定位使用页面队列，执行时再次核对录音身份与暂停状态；目录 portal 按播放源和页面身份匹配。真实节点解绑负责暂停、移除 src 和 load，StrictMode 重新绑定恢复源。删除按录音 ID 清理，避免迟到删除响应停止另一份录音。原生 audio 节点在 Shell 内唯一常驻，详情页卸载不得触碰它。
