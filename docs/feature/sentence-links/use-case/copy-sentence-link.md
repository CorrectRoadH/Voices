---
format: concord.document/v1
id: copy-sentence-link
title: 复制句子引用并返回原位置
createdAt: 2026-10-18T01:24:08.993Z
kind: use-case
feature: docs/feature/sentence-links/README.md
---

# 复制句子引用并返回原位置

Given 用户查看一个历史转写版本，目标句子不在默认加载的第一页。

When 复制 `[张三: 明天上午讨论方案](https://voices.example/recordings/r/transcriptions/t?segment=s)` 并打开链接。

Then 登录后加载版本 t，定位片段 s，有时间信息时定位音频；当前激活版本不因此改变。

r、t、s 在实际链接中均为 UUID。修改片段文字和人物后 ID 不变；删除录音后链接明确不可用。

没有时间戳时仍能定位文字。含方括号、反斜杠或换行的原文复制后不能破坏 Markdown 链接。

定位以正文实际滚动容器为准，目标消息居于可视阅读区域中部（首尾边界允许受剩余内容限制）；手机按播放器上方的可视窗口定位。等待正文与字体布局就绪后定位，分页补载保留阅读位置，不与初次定位竞争滚动。目标以整行淡色背景短暂强调后淡出，不保留气泡描边；重复定位同一句重新强调。减少动态效果偏好下仅短暂显示静态背景。搜索和目录跳转复用相同定位反馈。
