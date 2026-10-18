# Goals

## G1: Replace instances

上传成功后的任意应用实例可替换，已有会话与数据仍可访问，不依赖粘性路由。

## G2: Unified persistence

音频和业务数据统一由 PostgreSQL 备份恢复，不需要持久应用磁盘。

## G3: Bounded streaming

支持最大 2 GiB 的既有上传契约、HTTP Range 和有界内存，网络传输不维持长数据库事务。
