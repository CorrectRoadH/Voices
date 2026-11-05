# 跨录音声纹设计

## 目标与范围

用户人工关联说话人后，系统从该标签的有效原始发言建立声纹。后续导入完成转写后自动匹配同账号未归档人物。自动关联可人工覆盖，不能成为后续认人的依据。背景声、音乐、系统提示音不建档。逐段覆盖用于纠错并排除原标签样本；只有人工确认整个标签才为其人物建档。

声纹是声音特征向量，不是合成声音。模型服务自行部署，不向转写商新增上传；模型文件为可重建程序资源，音频及声纹业务数据仍由 PostgreSQL 持有。不开启模型服务时，既有导入与人物关联照常工作。

## 边界与取舍

标准 Docker Compose 部署默认启动独立声纹容器并配置应用连接，无需额外叠加文件或网页开关。源码 Compose 构建该服务；单文件快速安装使用同仓库镜像的 `voiceprints-latest` 标签，正式发布同时产出 `voiceprints-X.Y.Z` 与浮动标签，固定版本部署应同时固定两个镜像。模型仍在独立私网容器运行，生命周期和持久化边界不变。显式空 `VOICEPRINT_URL` 可停用应用声纹任务；非 Compose 部署仍需提供可达的服务地址，不把配置缺失伪装为可用。已有部署需更新 Compose 后重建服务，仅更新应用镜像不足以启动新服务。

采用独立 CPU 推理服务（Python、sherpa-onnx、3D-Speaker CAMPPlus 中文 16k 模型），Go 负责取样、样本所有权、匹配与任务。服务仅接收最多 10 秒的 16kHz 单声道 PCM，返回模型身份与 192 维有限浮点向量。模型身份包含 ONNX SHA256；客户端拒绝身份或维度不符，禁止跨模型比较。服务不接收人物、账号或录音 ID，不保存请求。服务仅放在私有网络，不发布宿主端口；直接运行默认绑定 loopback。

相对于把声纹耦合到 STT 服务商，此方案可保留现有转写适配器并支持历史音频。代价是增加一个独立推理进程和模型下载。部署用独立 Compose 覆盖文件显式启用；普通部署不隐式下载模型。Go 配置 VOICEPRINT_URL，模型固定版本，匹配阈值初始为余弦 0.80、不同人物间距 0.12；这不是概率或已校准准确率。

## 数据模型

- speaker_labels 增加 identity_source（unassigned/manual/automatic）、match_score（可空，0..1）。迁移中所有旧标签均标为 manual，包括 null，以保留无法追溯的人工解除意图；仅迁移后的新转写标签默认 unassigned。人工提交 person_id（含 null）改为 manual 并清空分数；显式解除不再自动覆盖。
- speaker_voiceprints：label_id UUID 主键并外键 speaker_labels ON DELETE CASCADE，model TEXT，embedding DOUBLE PRECISION[]（192 维），sample_ms BIGINT，sample_count INTEGER，created_at TIMESTAMPTZ。人物身份由标签现时关联读取，不另存人物副本；训练查询只纳入 manual、非内置、未归档人物、未删除录音，且排除待识别录音本身。人物参考为同一模型各标签向量的归一化平均，人物重命名不影响声纹。
- voiceprint_tasks：transcription_id UUID 主键并外键 transcriptions ON DELETE CASCADE；generation UUID、state（queued/running/succeeded/failed）、lease_until TIMESTAMPTZ?、error_code TEXT?、updated_at TIMESTAMPTZ。按 state/updated_at 建索引。另设 voiceprint_execution 单行槽（id BOOLEAN 主键且恒 true，run_id UUID、lease_until TIMESTAMPTZ），无录音外键。全实例最多一个有效执行槽，领取用 advisory transaction lock 同时占槽和领取任务；每任务上限 15 分钟，租约 16 分钟，不续租。提交必须 generation 一致、running、未过期。过期允许重新领取并换 generation；旧执行者无法发布。编辑/删除只撤销内容 generation，不清除执行槽；执行者每块推理前及发布前检查代次，撤销后退出并按 run_id 释放槽。任何退出路径都释放自己持有的槽，崩溃后等待槽到期。服务端使用单线程 HTTPServer、accept backlog=1、连接读超时，无应用级排队线程，客户端取消不声明原生推理已停止。

两张新表从唯一父外键推导归属；API 必须走现有 authorizeResource，后台候选查询显式 owner_id。数据库不新增 pgvector：个人规模线性比对足够，避免数据库扩展依赖。

## 触发与一致性

转写成功、人工标签关联、片段说话人或时间变更均在原业务事务中删除该转写的旧声纹并 upsert queued 任务，换 generation 撤销在途结果。仅改正文不失效。即使未配置服务也保存排队任务；配置后可继续。模型不工作不改变转写成功状态。

模型耗时工作全部在事务外进行。提取前在录音锁下读取任务 generation 和当前时间片段；完成后重新锁录音、核对任务 generation/期限，再写向量并匹配。人工编辑继续采用现有录音锁。匹配与影响训练资格的人工操作用同一账号级 advisory transaction lock 串行化；顺序为录音锁→账号锁→标签/片段写入。人物归档在人物写入前取账号锁，录音逻辑删除在录音锁后取账号锁。匹配事务不锁其它录音/人物行，避免跨录音反向锁。这样已提交的纠错/删除/归档不会被后续匹配使用。

自动结果只更新 identity_source=unassigned 且 person_id IS NULL 的标签，并递增标签 revision；不覆盖人工操作和已自动关联结果。用户重新选择同一人物可显式确认自动标签，使之成为人工样本。旧自动关联不因后来删除训练样本而追溯改写；后续匹配立即停止使用已失效样本。

源录音删除后训练查询立即排除，物理清理级联删除向量/任务。临时音频使用现有 blob lease 复制到任务临时目录，所有路径（成功、失败、取消）关闭 reader 并删除临时目录。应用退出取消 ffmpeg 与 HTTP，请求有超时；未发布任务等待租约到期恢复。恢复模式不领取任务，恢复时 running 换 generation 后回 queued。

## 取样与匹配

只用 assignment_mode=inherit 的标签片段、可靠成对时间戳、录音时长以内且不与不同来源标签、未知来源或任意显式 unknown/label 覆盖片段重叠的区间（即使来源相同）。同来源 inherit 区间先 union 去重，遇到阻挡区间保守丢弃相交候选区间，不拼接音频。每块 3–10 秒，每标签最多 6 块、30 秒，至少两块且总计 6 秒；长片段可拆块，不把静音补成样本。最多 128 标签、读取最多 20000 片段，超限明确失败而非部分自动认人。模型服务拒绝低能量/严重削波输入；各块先归一化，任意两块余弦低于 0.65 时丢弃整个标签；零范数、非有限或近零均值拒绝，防止混合标签训练。

每个人物取同模型的有效人工标签向量均值归一化。最多读取 5000 个有效参考标签，超限任务失败不静默截断。只有最佳人物得分≥0.80 且与第二候选差≥0.12 才自动关联；没有合格声纹、样本不足或不确定均保留匿名标签，不猜测最接近的人物。无其它候选时仍要求绝对阈值。声纹失败可从录音页重试，不重新发起付费转写。

## 可观察接口

GET /transcriptions/{id}/voiceprints 返回 configured、task（state/error_code 或 null）和 samples（可用标签数量）；task 包含 generation 与 updated_at，用作发布刷新身份。POST 同路径将成功转写重新排队，幂等合并 queued/running；需现有鉴权、CSRF、恢复模式写保护。GET /people/{id}/voiceprints 返回 configured、samples、sample_ms；POST 同路径将这个人物的人工关联历史转写排队，不改已有身份，只建档/匹配尚未关联标签；归档/内置人物拒绝。

人物页显示声纹样本数、有效时长、从已标识录音建立/更新样本的入口。录音页显示声纹处理状态、失败重试及自动标签标记。中文英文同步；未配置服务显示未启用，不展示“已识别”。HTTP 响应不暴露向量或模型服务地址。

## 验收

使用隔离 PostgreSQL 和正式 HTTP：人工标识→队列→提取→另一录音自动关联；自动标签不进入训练；未知/近似人物保留匿名；跨账号隔离；归档/删除/改标/单段覆盖/时间更改失效；人工清空不被覆盖；旧 generation 和过期租约不发布；失败及重试不调用 STT；恢复与删除无悬挂引用。fake 仅替代外部推理响应，真实 ffmpeg/数据库/匹配均执行。

真实模型另用公开语音验证不同片段同人及异人，记录模型 SHA、得分、速度，不以合成音或 fake 声称识别人声准确率。浏览器验证人物/录音声纹状态和重试入口。执行 vp run check 与相关真实浏览器测试；用户真实环境准确率仍需其录音校准，不以样本演示作普遍保证。

## 固定模型与出站协议

工件：https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx 。SHA256 为 f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11；服务下载校验后才加载。完整身份为 campplus-zh-v1:sherpa-2.0.1:s16le-16000-mono:f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11。Go 独立固定相同身份，每个响应均校验；模型更换须升级 profile 并显式重建历史样本，旧 profile 不计入有效样本。

VOICEPRINT_URL 只接受可信部署配置的 http/https origin，禁止 userinfo/query/fragment/非根路径；专用客户端禁环境代理、禁重定向。POST /embedding 使用 application/octet-stream，正文 s16le、16kHz、mono，3–10 秒（96000–320000 字节）；服务端检查 Content-Length、Transfer-Encoding、奇数字节及低能量/削波，响应上限 16KiB，单步 30 秒，任务总限 15 分钟。GET /healthz 只用于服务健康检查，返回固定模型身份。网络隔离是服务访问边界，不承诺将普通 HTTP 暴露公网。

自动发布在同事务中写向量、人物关联和 succeeded 状态。录音页观察 task.generation/updated_at 的成功发布变化，调用现有 refresh 更新 version 与 TranscriptStore，保留播放器实例/播放位置及现有草稿机制。切换版本后旧响应不能刷新新版本。测试须先打开匿名正文，再完成后台识别，观察名字自动更新而非手动刷新。

启用前替换并停止全部旧应用副本；不支持新旧二进制混部启用声纹。数据库快照恢复同时撤销执行槽。

## 独立设计审查裁决

2026-11-04 原生 Codex GPT-6.1 Sol 经 Herdr 独立审查提出四项必修：执行槽独立于可失效任务、最小两两余弦检查、旧 null 保留人工匿名、显式纠错区间阻挡与重叠去重。全部按本页规则采纳；同时补全固定 profile、受限出站协议、正文缓存刷新和停止旧副本的升级条件。验收增加真实在途请求并发观察、192 维正交/半相似反例、旧 schema 解除后迁移，以及同来源重叠纠错。

同日独立限定复核确认四项 P1 及上述 P2 均已关闭，无剩余设计阻塞。设计放行不替代实现与实际验收。
