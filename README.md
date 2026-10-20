# Voices

中文 · [English](README.en.md)

给习惯随身录音的人用的。录音笔、手机录下的一整天，丢进 Voices 自动转成文字、分好说话人。谁在哪天说过什么，搜一下就能找到，点一下就能回放。数据存在你自己的服务器上。

## 功能

- 自动转写，区分说话人
- 在线校对和整理
- 引用原句，跳回录音
- AI 摘要（可选）
- 多人共用

## 快速开始

需要 Docker，以及一个 [Soniox](https://soniox.com) 或 [AssemblyAI](https://www.assemblyai.com) 的 API key。

```sh
mkdir voices && cd voices
curl -fsSLO https://raw.githubusercontent.com/CorrectRoadH/Voices/main/deploy/compose.yaml
docker compose up -d
```

打开 <http://localhost:8080>，按页面提示操作：

1. 注册账号。第一个注册的账号就是管理员。
2. 配置 AI 摘要用的模型，不需要可以跳过。
3. 在「服务器管理」填入转写服务的 API key，就可以拖入录音了。

### 从手机或其他电脑访问

Voices 默认在局域网开放 8080 端口。想用本机 IP 访问，第一次启动时带上这个地址：

```sh
PUBLIC_BASE_URL=http://192.168.1.10:8080 docker compose up -d
```

把 `192.168.1.10` 换成运行 Voices 的机器的 IP。地址会保存下来，之后正常启动即可。如果已经启动过，就在「服务器管理 → 服务器设置」里修改站点地址，然后执行 `docker compose restart`。不设置这个地址的话，从其他设备打开能看到页面，但无法登录。

启动后请尽快注册管理员账号，以免同一网络里的其他人先注册。需要公网访问时，请在前面放一个提供 HTTPS 的反向代理，详见[部署文档](docs/operations.md)。

### 升级

```sh
docker compose pull && docker compose up -d
```

所有数据都在 `postgres_data` 卷里。升级前建议先备份，方法见[备份与恢复](docs/operations.md)。

## 致谢

感谢 [Linux Do](https://linux.do) 在项目早期开发阶段提供的支持与反馈。
