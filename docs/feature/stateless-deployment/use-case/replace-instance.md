---
format: concord.document/v1
id: replace-instance
title: 替换实例不丢失已接受数据
createdAt: 2026-10-18T01:18:38.296Z
kind: use-case
feature: docs/feature/stateless-deployment/README.md
---

# 替换实例不丢失已接受数据

Given A 与 B 使用相同部署配置并共享 PostgreSQL，用户已登录。

When 在 A 导入录音并收到成功响应，销毁 A 及其临时磁盘，然后将请求发给 B。

Then B 继续识别该会话，可读取原始音频、播放副本和转写，编辑人物关联。

已领取任务等待租约到期后由 B 接管；未开始远端操作可继续，已知远端 ID 仅轮询，不确定操作要求核对。

若在上传完成响应前销毁 A，则该次上传可以失败；重传不产生重复录音，过期未发布块被回收。
