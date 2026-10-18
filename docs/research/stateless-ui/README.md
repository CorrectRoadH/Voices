---
format: concord.document/v1
id: stateless-ui
title: 音频入库与 UI 工具依据
createdAt: 2026-10-18T01:25:57.702Z
kind: research
sources: []
---

# 音频入库与 UI 工具依据

查阅日期：2026-10-18。文档能力与设计选择分开记录；尚未进行媒体吞吐或数据库容量实测。

## PostgreSQL 二进制数据

PostgreSQL 提供 bytea 二进制列与 Large Objects。官方说明 TOAST 字段上限 1 GB，Large Object 可更大且支持局部读取。
Large Object 客户端描述符仅在事务内有效；采用其流式接口时必须设计事务与网络传输边界。

本项目选择 1 MiB bytea 块与关系表清单，是应用设计取舍，不是 PostgreSQL 官方推荐结论。它保留普通外键、短事务和统一备份。
代价是需要实现发布、租约、回收和块范围读取；音频进入数据库后，数据库容量、WAL 与备份流量随之增长。

- [Binary data types](https://www.postgresql.org/docs/current/datatype-binary.html)
- [Large Objects 介绍](https://www.postgresql.org/docs/current/lo-intro.html)
- [Large Object 客户端接口](https://www.postgresql.org/docs/current/lo-interfaces.html)

## shadcn/ui 与 Base UI

用户指定 shadcn/ui + Base UI。shadcn 官方提供 Vite 安装步骤；Base UI 官方将 shadcn/ui 列为预设样式组件入口。
组件基础库使用 @base-ui/react，按 Base UI 组合 API 编写，不混用 Radix 的专有属性。Vite+ 保持现有工具链选择。

- [shadcn Vite 安装](https://ui.shadcn.com/docs/installation/vite)
- [shadcn Skills](https://ui.shadcn.com/docs/skills)
- [Base UI Quick start](https://base-ui.com/react/overview/quick-start)
- [官方 skill 源码](https://github.com/shadcn-ui/ui/tree/main/skills/shadcn)

skill 是开发工具，不是应用运行时依赖。安装 skill 不代表已经安装前端组件或生成应用代码。
