---
format: concord.document/v1
id: updates
title: 版本更新与公告
createdAt: 2026-10-18T06:31:39.726Z
kind: feature
constitutionRefs:
  - docs/constitution.md#c-001
  - docs/constitution.md#c-004
---

# 版本更新与公告

管理员在服务器设置查看当前版本、最新正式版本、发布说明和有效公告，手动检查或由运行中的服务每 24 小时检查。更新服务仅用于通知，不自动安装软件、不发送实例标识、运行环境或业务数据。

UPDATE_URL 为空时禁用外部检查。开发版本、尚未检查、失败与已是当前发布版本分别呈现。失败保留上次成功内容并明确其时间；只有最新正式版本高于当前正式版本才提示升级。公告和发布说明以纯文本展示，外链仅允许 HTTPS，过期公告不展示。

[设计与外部服务契约](../../research/release-updates/README.md) · [查看与检查更新](use-case/check-updates.md) · [发布机制](../../engineering/delivery/README.md)
