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

需要 Docker，以及一个 [Soniox](https://soniox.com)、[ElevenLabs](https://elevenlabs.io) 或 [AssemblyAI](https://www.assemblyai.com) 的 API key。

```sh
mkdir voices && cd voices
curl -fsSLO https://raw.githubusercontent.com/CorrectRoadH/Voices/main/deploy/compose.yaml
docker compose up -d
```

打开 <http://localhost:8080>，按页面提示操作：

1. 注册账号。第一个注册的账号就是管理员。
2. 配置 AI 摘要用的模型，不需要可以跳过。
3. 在「服务器管理」填入转写服务的 API key，就可以拖入录音了。

使用 ElevenLabs 时，保存 API key 后重启应用（Docker Compose 可运行 `docker compose restart app`），在「转写偏好」选择 **ElevenLabs → Scribe v2**。导入录音或新建转写版本时，Voices 会把所选录音发送到 ElevenLabs。

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

声纹引擎和模型内置于 Go 程序：标识人物后建立声纹，后续录音自动匹配。直接运行或 `air .` 均无需额外服务和配置。

所有数据都在 `postgres_data` 卷里。升级前请[备份数据库](docs/operations.md#备份与恢复)。

#### 升级到 PostgreSQL 19

保留旧的 Compose 文件。在原部署目录用原项目名执行 `docker compose stop app db`，换上新版 Compose，再执行 `docker compose up -d`。一次性服务会把旧卷的 `18/docker` 集群自动升级到同一卷的 `19/docker`，数据库和应用随后启动。全新安装和已完成升级的部署会跳过迁移。

迁移至少需要旧集群大小 1.2 倍的可用空间，并需要连接 PostgreSQL APT 软件源来下载 PostgreSQL 18。失败时运行 `docker compose logs postgres-upgrade`。排除问题后再运行 `docker compose up -d`。

若需回退，执行 `docker compose stop app db`，换回旧 Compose 文件，再执行 `docker compose up -d`。旧集群保留升级前的数据。若自动升级持续失败，可在旧配置下启动数据库，再按下列步骤手动迁移。

1. 保持应用停止，导出旧库。

   ```sh
   umask 077
   docker compose exec -T db pg_dump -U voices -d voices -Fc > voices-pg18.dump &&
     docker compose stop db
   ```

2. 换上新版 Compose，在同一卷内的临时目录初始化 PG19。

   ```sh
   restore_container=$(docker compose run -d --no-deps \
     -e PGDATA=/var/lib/postgresql/19/manual-restore db)
   ```

3. 在同一终端执行 `docker exec "$restore_container" pg_isready -h 127.0.0.1 -U voices -d voices`。确认接受连接后，导入备份并启动完整应用。

   ```sh
   docker exec -i "$restore_container" pg_restore -U voices -d voices --single-transaction < voices-pg18.dump &&
     docker stop "$restore_container" &&
     docker rm "$restore_container" &&
     docker compose run --rm --no-deps --entrypoint sh db -ec '
       if [ -d "$PGDATA" ]; then rmdir "$PGDATA"; fi
       mv -T /var/lib/postgresql/19/manual-restore "$PGDATA"
     ' &&
     docker compose up -d
   ```

确认应用数据完整并备份 PG19 后，可以删除旧集群释放空间。该操作会失去用旧集群回退的能力。

```sh
docker compose exec -T db psql -U voices -d voices -Atc 'SHOW data_directory'
# 确认输出为 /var/lib/postgresql/19/docker 后执行
docker compose exec -T -u root db rm -rf -- /var/lib/postgresql/18/docker
```

## 致谢

感谢 [Linux Do](https://linux.do) 在项目早期开发阶段提供的支持与反馈。
