# 自托管声纹服务

人工标识人物后自动建立声纹，新导入录音完成转写后匹配已有人工样本。第一次启用可在人物页点击“从已标识录音更新声纹”。至少需要两块互不重叠的清晰语音，总计六秒；陌生人、相似候选或样本不足保持匿名。自动关联须人工确认后才成为参考样本。

## 默认启用

仓库根目录和快速安装的 Compose 都默认启动声纹服务并连接应用，无需额外配置文件或网页开关。首次安装会拉取或构建模型镜像。

升级已有部署时先更新 Compose 文件，再停止并替换全部旧版本 Voices 副本；不支持启用声纹时混用新旧二进制。只拉取应用镜像不会给旧 Compose 增加服务。

```sh
docker compose up -d --build
```

源码部署使用上面的构建命令；快速安装使用 `deploy/compose.yaml` 与 `docker compose pull && docker compose up -d`。预构建模型镜像为 `correctroad/voices:voiceprints-latest`，固定版本时设置 `VOICEPRINT_IMAGE=correctroad/voices:voiceprints-X.Y.Z`，与应用版本一致；这些标签由正式 Release 流程发布，提交源码不会发布镜像。原 `compose.voiceprints.yaml` 保留为兼容叠加文件，已不再需要。显式设置 `VOICEPRINT_URL=` 可关闭识别。

该命令用于部署者自行执行。本服务不暴露宿主端口，无持久卷。模型文件作为镜像工件下载并校验；样本向量和任务保存在主应用的 PostgreSQL，数据库备份须一起保留。模型服务失败不影响转写和手动关联，可在录音页重试声纹任务，不会重跑 STT。

直接运行：Python 3.12，按 requirements.txt 安装依赖，将下面工件保存到本地并设置 `MODEL_PATH`，运行 `python server.py`。默认只监听 `127.0.0.1:8091`；主应用设置 `VOICEPRINT_URL=http://127.0.0.1:8091`。不要将无鉴权的模型端口暴露到公网。URL 只能来自部署配置，禁止凭据、路径、查询和片段；客户端不使用环境代理、不跟随重定向。

## 固定模型

- 推理：sherpa-onnx 2.0.1，CPU，两线程。
- 模型：[3D-Speaker CAMPPlus 中文 16k](https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx)。
- SHA256：`f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11`。
- [3D-Speaker](https://github.com/modelscope/3D-Speaker) 与 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 使用 Apache-2.0，见各上游 LICENSE；Python 依赖包携带各自许可证。
- 协议：POST `/embedding`，`application/octet-stream`，s16le/16kHz/单声道，3–10 秒；输出固定 profile 与 192 维归一化向量。GET `/healthz` 返回模型身份。服务端串行推理、有界等待，不保存请求和音频。

自动关联默认要求余弦相似度至少 0.80，且比第二人物高至少 0.12；同标签样本任意两块至少 0.65。这些值不是概率，也不是用户录音的准确率保证。换模型或特征提取语义必须升级固定 profile，并从原音频重建声纹，不能混合不同 profile。

升级前已有的匿名标签会保留人工匿名语义，因为旧数据无法分辨“未关联”和“主动解除”。自动识别适用于升级后产生的新转写；已有人工人物关联可用于初始化声纹。

测试入口：`vp run test:voiceprints`（隔离 TEST_DATABASE_URL）、`vp run test:voiceprints:browser`；模型服务测试为 `MODEL_PATH=... python -m unittest discover -s voiceprint-service -p 'test_*.py'`。
