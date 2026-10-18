# 架构裁决

## Decision

媒体持久化与实例边界已由 [无状态存储裁决](../stateless-media/DECISION.md) 取代：音频改存 PostgreSQL，应用不再使用本地媒体卷。下文保留原始裁决记录。

Selected: [embedded](plans/embedded/README.md)

## Rationale

采用单个 Go 应用进程、PostgreSQL 持久任务与本地媒体卷。个人部署不需要独立消息队列和共享对象存储。
前端 Vite+、React；数据库仅 PostgreSQL，使用 pgxpool、原生类型及行锁领取任务，减少方言适配负担。

产品功能独立于模型能力：保留完整文本编辑、说话人标签与人物管理契约，缺时间或标签的结果按字段退化。
转写版本独立保存，用户校正不被重转覆盖；每次导入保存自动转写授权和模型/语言快照。

## Rejected Options

独立队列方案增加 Redis、worker 部署、共享媒体与恢复协调成本。当前单用户需求不需要水平扩容，故不采用。

## Residual Risks

外部服务受理状态不明时无法保证 exactly-once，使用持久化操作意图、uncertain 状态和人工核对避免盲目重发。
所有在途操作核对前保留删除墓碑；旧执行者只能登记已存在操作的资源，不得发布业务结果。

音频识别准确率、处理速度、费用和服务商清理行为需要后续真实样本验收。当前只完成设计与文档检查。
跨录音声纹自动认人仍待明确，不是已采用的初版能力；初版人物关联由用户确认。

## Review conclusions

独立原生 Codex / GPT-6.1 Sol 审查提出三项问题：上传操作意图、晚到资源登记、导入授权快照。
[架构](../../architecture.md) 已明确相应状态、事务与归属；针对这些修正和 PostgreSQL 原生化的复审通过，无阻塞定案问题。
