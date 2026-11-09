# 跨录音声纹设计

## 目标与范围

用户人工关联说话人后，系统从该标签的有效原始发言建立声纹。后续导入完成转写后自动匹配同账号未归档人物。自动关联可人工覆盖，不能成为后续认人的依据。背景声、音乐、系统提示音不建档。逐段覆盖用于纠错并排除原标签样本；只有人工确认整个标签才为其人物建档。

声纹是声音特征向量，不是合成声音。Go 进程内置 CAMPPlus 模型与 sherpa-onnx CPU 推理，无独立 Python/HTTP 服务、URL 或引擎配置。音频不向 STT 商新增上传，业务数据仍由 PostgreSQL 持有。资源所有权、固定版本、原生库分发和升级规则见[内置推理设计](embedded-voiceprints.md)。

## 边界与取舍

App 拥有惰性 Engine，单槽串行推理，退出先等待任务再销毁。原生调用不可抢占，取消后等待调用结束且不发布结果；临时模型加载后清理。模型编入 Go 程序，但官方绑定需要 CGO 和随发行包携带的动态库。无需额外运行服务。匹配阈值为余弦 0.80、不同人物间距 0.12，不是概率或已校准准确率。

## 数据模型

- speaker_labels 增加 identity_source（unassigned/manual/automatic）、match_score（可空，0..1）。迁移中所有旧标签均标为 manual，包括 null，以保留无法追溯的人工解除意图；仅迁移后的新转写标签默认 unassigned。人工提交 person_id（含 null）改为 manual 并清空分数；显式解除不再自动覆盖。
- speaker_voiceprints：label_id UUID 主键并外键 speaker_labels ON DELETE CASCADE。model TEXT，embedding DOUBLE PRECISION[]（192 维），sample_ms BIGINT、sample_count INTEGER。created_at TIMESTAMPTZ。人物身份由标签现时关联读取，不另存人物副本；训练查询只纳入 manual、非内置、未归档人物、未删除录音，且排除待识别录音本身。人物参考为同一模型各标签向量的归一化平均，人物重命名不影响声纹。
- voiceprint_tasks：transcription_id UUID 主键并外键 transcriptions ON DELETE CASCADE。generation UUID、state（queued/running/succeeded/failed）、lease_until TIMESTAMPTZ?、error_code TEXT?。updated_at TIMESTAMPTZ。按 state/updated_at 建索引。

另设 voiceprint_execution 单行槽（id BOOLEAN 主键且恒 true，run_id UUID、lease_until TIMESTAMPTZ），无录音外键。全实例最多一个有效执行槽，领取用 advisory transaction lock 同时占槽和领取任务；每任务上限 15 分钟，租约 16 分钟，不续租。

提交必须 generation 一致、running、未过期。过期允许重新领取并换 generation；旧执行者无法发布。

编辑/删除只撤销内容 generation，不清除执行槽；执行者每块推理前及发布前检查代次，撤销后退出并按 run_id 释放槽。任何退出路径都释放自己持有的槽，崩溃后等待槽到期。同进程领取前获取原子槽，数据库清理后释放；原生调用返回前不释放资源。

两张新表从唯一父外键推导归属；API 必须走现有 authorizeResource，后台候选查询显式 owner_id。数据库不新增 pgvector：个人规模线性比对足够，避免数据库扩展依赖。

## 触发与一致性

转写成功、人工标签关联、片段说话人或时间变更均在原业务事务中删除该转写的旧声纹并 upsert queued 任务，换 generation 撤销在途结果。仅改正文不失效。历史升级任务领取时优先处理有效人工参考，再处理匿名录音。模型不工作不改变转写成功状态。

模型耗时工作全部在事务外进行。提取前在录音锁下读取任务 generation 和当前时间片段；完成后重新锁录音、核对任务 generation/期限，再写向量并匹配。人工编辑继续采用现有录音锁。匹配与影响训练资格的人工操作用同一账号级 advisory transaction lock 串行化；顺序为录音锁→账号锁→标签/片段写入。人物归档在人物写入前取账号锁，录音逻辑删除在录音锁后取账号锁。匹配事务不锁其它录音/人物行，避免跨录音反向锁。这样已提交的纠错/删除/归档不会被后续匹配使用。

自动结果只更新 identity_source=unassigned 且 person_id IS NULL 的标签，并递增标签 revision；不覆盖人工操作和已自动关联结果。用户重新选择同一人物可显式确认自动标签，使之成为人工样本。旧自动关联不因后来删除训练样本而追溯改写；后续匹配立即停止使用已失效样本。

源录音删除后训练查询立即排除，物理清理级联删除向量/任务。临时音频使用现有 blob lease 复制到任务临时目录，所有路径（成功、失败、取消）关闭 reader 并删除临时目录。应用退出取消 ffmpeg 并等待原生推理结束；未发布任务等待租约到期恢复。恢复模式不领取任务，恢复时 running 换 generation 后回 queued。

## 取样与匹配

只用 assignment_mode=inherit 的标签片段、可靠成对时间戳、录音时长以内且不与不同来源标签、未知来源或任意显式 unknown/label 覆盖片段重叠的区间（即使来源相同）。

同来源 inherit 区间先 union 去重，遇到阻挡区间保守丢弃相交候选区间，不拼接音频。

每块 3–10 秒，每标签最多 6 块、30 秒，至少两块且总计 6 秒。

先从整份录音生成不重叠候选（每个连续区间最多六块），按长度降序、同长度按开始时间排序再选取，避免开场短句占满预算；只有一块且不少于六秒时平分为两块。

重叠排除与两两纯度阈值同时适用，不把静音补成样本。

最多 128 标签、读取最多 20000 片段，超限明确失败而非部分自动认人。

内置引擎拒绝低能量/严重削波输入；各块先归一化，任意两块余弦低于 0.65 时丢弃整个标签；零范数、非有限或近零均值拒绝，防止混合标签训练。

每个人物取同模型的有效人工标签向量均值归一化。最多读取 5000 个有效参考标签，超限任务失败不静默截断。只有最佳人物得分≥0.80 且与第二候选差≥0.12 才自动关联；没有合格声纹、样本不足或不确定均保留匿名标签，不猜测最接近的人物。无其它候选时仍要求绝对阈值。暂时性失败由后台自动重试，不重新发起付费转写。

## 可观察接口

GET /transcriptions/{id}/voiceprints 返回 configured、task（state/error_code 或 null）和 samples（可用标签数量）；task 包含 generation 与 updated_at，用作发布刷新身份。POST 同路径将成功转写重新排队，幂等合并 queued/running；需现有鉴权、CSRF、恢复模式写保护。GET /people/{id}/voiceprints 返回 configured、samples、sample_ms；POST 同路径将这个人物的人工关联历史转写排队，不改已有身份，只建档/匹配尚未关联标签；归档/内置人物拒绝。

人物与录音页不提供声纹面板、按钮或样本管理页面；只展示关联人物和自动标签标记，保留正常纠错。中文英文同步；configured 恒 true，表示默认内置能力，任务状态另行表示处理结果。HTTP 响应不暴露向量。

## 验收

使用隔离 PostgreSQL 和正式 HTTP：人工标识→队列→提取→另一录音自动关联。自动标签不进入训练。未知/近似人物保留匿名。跨账号隔离。归档/删除/改标/单段覆盖/时间更改失效。人工清空不被覆盖。旧 generation 和过期租约不发布。失败及重试不调用 STT。恢复与删除无悬挂引用。

fake 仅替代原生推理边界，真实 ffmpeg/数据库/匹配均执行。

真实模型另用公开语音验证不同片段同人及异人，记录模型 SHA、得分、速度，不以合成音或 fake 声称识别人声准确率。浏览器验证无声纹维护面板、人物自动关联与人工纠错。执行 vp run check 与相关真实浏览器测试；用户真实环境准确率仍需其录音校准，不以样本演示作普遍保证。

## 固定模型与升级

模型 SHA256 为 f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11。profile 为 campplus-zh-v2:sherpa-1.13.8:s16le-16000-mono:f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11；旧 profile 不参与比较。历史数据的重排队和停机要求见[声纹升级](../../../operations.md#声纹自动关联)。工件出处、许可、输入和分发验收见[内置推理设计](embedded-voiceprints.md)。

自动发布在同事务中写向量、人物关联和 succeeded 状态。录音页观察 task.generation/updated_at 的成功发布变化，调用现有 refresh 更新 version 与 TranscriptStore，保留播放器实例/播放位置及现有草稿机制。切换版本后旧响应不能刷新新版本。测试须先打开匿名正文，再完成后台识别，观察名字自动更新而非手动刷新。

启用前替换并停止全部旧应用副本；不支持新旧二进制混部启用声纹。数据库快照恢复同时撤销执行槽。

## 验收反例

验收覆盖长短发言候选的确定性排序、六块/三十秒预算、最少两块及重叠与人工纠错排除。另覆盖独立执行槽、最小两两余弦、人工匿名、显式纠错区间阻挡与重叠去重。包含真实在途并发、192 维正交与半相似向量、旧 schema 升级和同来源重叠纠错；不能用设计检查代替运行验收。

## 自动维护

后台既有 maintenance 周期每次最多补齐 100 个 ready 录音、succeeded 转写且有标签但无声纹任务的记录。

已成功任务（包括零样本）不重复排队。

failed 中 inference_unavailable、interrupted、processing_failed 在 updated_at 满五分钟后再次排队；永久模型不匹配、非法向量与输入上限错误不自动循环。

排队更新 generation，保留现有执行槽与人工关联，queued/running 不被维护覆盖；恢复模式禁止维护。

无需浏览器在线。

维护与用户触发使用同一队列、锁与资源所有权。

录音页用无界面的观察 hook 跟踪发布并刷新人物，暂时失败的重试等待期以 30 秒检查，运行中五秒检查；终态仍停止。
