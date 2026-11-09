# 产品功能

这里按用户想完成的事组织已采用的契约。每项功能的 README 提供上手行为与用户路径，内部实现由各自架构页解释；文档存在不等于功能已经验收。

## 保存、阅读与整理录音

- [录音库与导入](recording-library/README.md)：保存、查找和校准录音信息。
- [多服务商转写](transcription/README.md)：生成版本、阅读、校对、搜索和处理失败任务。
- [说话人与人物](people/README.md)：人工关联、资料维护与内置声纹识别。
- [逐句引用](sentence-links/README.md)：复制引用并返回原版本。
- [摘要与主题目录](insights/README.md)：手动生成摘要并定位原文。

## 账号与界面偏好

- [独立账号与系统管理](accounts/README.md)：注册、数据隔离、站点配置与统一身份登录。
- [全站交互反馈](interface-interactions/README.md)：加载、编辑、保存和错误反馈。
- [界面主题](appearance/README.md)：跟随系统、浅色和深色。
- [界面语言](interface-language/README.md)：简体中文与英文。

## 管理与运行实例

- [站点运行状态与日志](administration/README.md)：概览、账号筛选、审计和运行日志。
- [外部调用记录](call-logs/README.md)：查看 STT/AI 请求尝试及安全诊断。
- [版本更新与公告](updates/README.md)：检查版本、查看发布说明和公告。
- [无状态部署](stateless-deployment/README.md)：替换实例并保留已接受数据。

全站加载、编辑与操作反馈见[交互契约](interface-interactions/ui.md)。用 `concord list feature` 查询派生文档关系；待决取舍见 [Design](../design/README.md)。
