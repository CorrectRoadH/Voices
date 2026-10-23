# Voices 产品与设计

## 产品契约

- [统一外部调用记录](feature/call-logs/README.md)

- [版本更新与公告](feature/updates/README.md)

- [独立账号与系统管理](feature/accounts/README.md)

- [录音库与拖入导入](feature/recording-library/README.md)
- [多服务商转写、语言与结果编辑](feature/transcription/README.md)
- [说话人与人物管理](feature/people/README.md)
- [逐句引用与深链接](feature/sentence-links/README.md)
- [无状态应用部署](feature/stateless-deployment/README.md)

## 架构与依据

- [STT 后台调用与估算费用方案（待评审）](research/stt-operations-cost/README.md)

- [独立账号与首位管理员方案](research/account-isolation/README.md)

- [架构、数据模型、API、资源生命周期与验收](architecture.md)
- [无状态存储方案与裁决](design/stateless-media/README.md)
- [初始架构裁决](design/foundation/README.md)
- [服务商与工具链调研](research/provider-selection/README.md)
- [音频入库与 UI 工具依据](research/stateless-ui/README.md)
- [领域词汇与例子](concepts.md)
- [项目原则](constitution.md)

## 开发机制

- [CI、Docker 与发布](engineering/delivery/README.md)
- [发布与更新服务设计](research/release-updates/README.md)

使用 [Concord](concord.md) 管理产品契约及代码/测试关系。Go 与前端测试入口见 [开发与测试](development.md)，不用默认 Node runner 声称验证 Go。
上述产品契约均已实现，并通过真实 PostgreSQL、HTTP 与浏览器验收；真实付费服务商样本验收尚未进行。

跨录音声纹自动认人、超长录音自动切片、摘要与团队协作均未纳入当前实现承诺。

运行入口：[部署与恢复](operations.md) · [开发与测试](development.md) · [HTTP 契约](api/implementation-contract.md) · [OpenAPI](api/openapi.json)。
