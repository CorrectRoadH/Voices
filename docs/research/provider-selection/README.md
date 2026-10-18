---
format: concord.document/v1
id: provider-selection
title: 转写服务商与工具链依据
createdAt: 2026-10-18T01:03:33.046Z
kind: research
sources: []
---

# 转写服务商与工具链依据

查阅日期：2026-10-18。以下是官方文档所述能力，不是本项目实测结论；价格和识别准确率尚未验证。

## Soniox

作为首选接入：提供异步文件转写、时间信息及说话人标签。标签仅说明音频内的发言归属，不能当作跨录音人物 ID。

官方当前给出单次异步音频上限 300 分钟；完成后应删除上传文件和转写资源。产品仍可保存超限录音，提交时提供解释。

- [异步转写](https://soniox.com/docs/stt/async/async-transcription)
- [说话人区分](https://soniox.com/docs/stt/concepts/speaker-diarization)
- [限制与资源保留](https://soniox.com/docs/stt/async/limits-and-quotas)

## AssemblyAI

第二个接入，用于检验归一化设计是否依赖单一服务商。官方预录音接口可返回带说话人信息的 utterances。
实际语言、模型组合和可选能力在 adapter 中确认，不将一款模型的能力当作全平台保证。

- [说话人区分](https://www.assemblyai.com/docs/pre-recorded-audio/label-speakers)
- [语言支持](https://support.assemblyai.com/articles/9106299104-what-languages-do-you-support-)

## Vite+

用户指定 Vite+ 与 React。官方支持 Vite 框架生态，将构建、检查和测试配置集中在 vite.config.ts。
部署产物为静态前端，由 Go 提供服务；不因此引入 Node 生产服务。

- [Vite+](https://viteplus.dev/)
- [配置](https://viteplus.dev/config/)

## 未验证项

实际音频的准确率、费用、处理速度与人物混淆率，须在实现后使用获得授权的样本验证。
本轮未上传任何音频、未调用收费转写 API，也未配置凭据。

## PostgreSQL 原生设计依据

数据库只支持 PostgreSQL。使用 pgx 原生驱动与连接池，UUID、TIMESTAMPTZ、BOOLEAN 和 JSONB 表达对应数据。
任务领取使用短事务内的 FOR UPDATE SKIP LOCKED；业务完成仍须校验租约代次，行锁不替代远端副作用恢复协议。

- [PostgreSQL SELECT 与锁定](https://www.postgresql.org/docs/current/sql-select.html)
- [PostgreSQL JSON 类型](https://www.postgresql.org/docs/current/datatype-json.html)
- [pgx 官方仓库](https://github.com/jackc/pgx)
