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

- [STT 后台调用与估算费用方案（待评审）](design/stt-pricing.md)

- [独立账号与首位管理员方案](feature/accounts/architecture/accounts.md)

- [架构、数据模型、API、资源生命周期与验收](architecture.md)
- [服务商与工具链调研](guides/provider-selection.md)
- [音频入库与 UI 工具依据](guides/storage-and-ui.md)
- [领域词汇与例子](concepts.md)
- [项目原则](taste.md)
- [写作规则](writing.md)
- [OpenAI 直接转写取舍（待决）](design/openai-transcription.md)

## 开发机制

- [CI、Docker 与发布](engineering/delivery/README.md)
- [发布与更新服务设计](feature/updates/architecture/service.md)

使用 [Concord](concord.md) 管理产品契约及代码/测试关系。Go 与前端测试入口见 [开发与测试](development.md)，不用默认 Node runner 声称验证 Go。
文档与源码、测试之间的关系由 Concord 派生；功能验收以实际测试结果为准。

跨录音声纹自动认人见[声纹识别](feature/people/use-case/recognize-speaker.md)，无需独立服务，见[内置推理](feature/people/architecture/embedded-voiceprints.md)。超长录音自动切片与团队协作未纳入当前实现承诺。

运行入口：[部署与恢复](operations.md) · [开发与测试](development.md) · [HTTP 契约](api/implementation-contract.md) · [OpenAPI](api/openapi.json)。
