---
format: concord.document/v1
id: interface-language
title: 界面语言
createdAt: 2026-10-19T03:57:48.906Z
kind: feature
---

# 界面语言

界面支持简体中文（zh-CN）与 English（en）。使用 i18next 与 react-i18next，翻译资源随构建发布，不使用在线翻译。覆盖导航、账号、录音库、转写详情、人物、任务、管理页面、表单验证、通知、无障碍名称及日期格式；浏览器标题保持 Voices。

界面语言和转写语言独立。录音标题、正文、人物姓名、备注、摘要及章节等用户内容原样显示，不按内容猜测语言。内置人物类别按固定 builtin_key 显示本地化名称。后台原始日志、服务商与模型标识保持原样。

登录后的语言偏好随账号保存，重新登录或更换浏览器后仍生效；不同账号独立。登录前可选择访客界面语言，保存在当前浏览器，默认简体中文；不覆盖账号语言。切换不重载或重挂载工作台，保留草稿、播放器和当前位置。

[选择界面语言](use-case/choose-language.md) · [设计与边界](../../research/interface-localization/README.md)
