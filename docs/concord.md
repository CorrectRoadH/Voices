# 使用 Concord 开发 Voices

Concord 连接产品契约、源码实现标记、测试标记和工程经验，落实[产品契约原则](taste.md#t-3)。使用前运行 `concord --skill`，按任务读取 `document`、`code`、`test`、`memory` 或 `trace` 等主题；命令参数以当前安装版本的 `--help` 为准。

## 文档归属

- [Feature](feature/README.md) 声明已采用的功能；每条用户路径放在 `use-case/<name>.md`。
- [Engineering](engineering/README.md) 声明本仓库的构建、测试和维护能力。
- [Roadmap](roadmap/README.md) 保存尚未采用的方向。
- [Design](design/README.md) 每个待决取舍占一个 Markdown 文件；定案后规则归入 Spec，删除 Design。
- [技术参考](guides/README.md) 保存外部资料依据。
- [Memory](../memory/README.md) 保存可复用经验；缺陷与待调查观察归 [Issue](issues/README.md)。

Spec 没有 frontmatter。仓库相对路径是身份，正文唯一的一级标题是名称。Feature、Engineering、Roadmap 包内页面使用 README、use-case、cli、library、api、format、ui、performance、architecture、data-model 等固定种类。architecture 与 data-model 描述内部实现，其余页面描述可观察行为。

除 Use Case 外，同一种可拆分页面需要多份时使用同名目录及 README 入口。`use-case/README.md` 是可选导航页，每条用户路径仍独立成文。移动文件同时更新 Markdown 链接、源码和测试标记，不能只修改导航。

## 原则、术语与写作

[项目原则](taste.md) 保留稳定条款编号，引用时链接到具体 anchor。[概念](concepts.md) 的每个二级标题声明唯一写法与 ID，首段给出定义。[写作规则](writing.md) 保存长度限制、禁用表达及作用范围。

这些 Markdown 文件可以直接编辑。目录决定概念与写作规则的生效范围；不另建 JSON owner 或手工索引。

## 查找与创建

```sh
concord list --json
concord list memory --json
concord memory search "任务恢复" --json
concord show docs/feature/accounts/README.md --json
concord new feature example --title "示例功能" --pages use-case
concord template list --json
```

`concord new` 创建文档；Spec 正文声明目标和验收，不写实施日志。Memory 仅保留可复用经验，可选 frontmatter 记录 `relations`。Issue 的状态和修复结论遵守 `concord --skill feedback`。远端 Issue 写入必须先预览并取得具体授权，本地操作不授权远端修改。

## 实现与测试关系

源码使用 `@concord-file`、`@concord-code` 或成对的 `@concord-begin` / `@concord-end`，紧接 `@concord-implements <Spec路径>`。测试使用 `@feature` 或 `@use-case`，必要时指向具体步骤 anchor；回归测试用 `@issue` 指向 Issue。

`concord.config.ts` 保留独立的测试根、源码根及 `vp run check` command runner。当前源码自动扫描 JS/TS；Go 测试标记可读取，Go 实现符号分析需要显式语言服务配置，不能把未扫描当成没有实现。

```sh
concord check --json
concord doctor --json
concord trace check --json
concord trace gaps --fresh --json
concord test list --json
concord code list --json
```

这些命令不运行产品测试。`trace gaps` 表示缺少显式关系，不是覆盖率；没有配置原生 adapter 时，runner 的成功不证明选中了某个原生 case。

实际运行与验收见[开发与测试](development.md)。完整项目门禁为 `vp run check`，需要隔离的 `TEST_DATABASE_URL`；浏览器与 workerd 使用各自独立入口。

## 模板与工作流 skill

[模板](_template/README.md) 提供写作提示，不代表功能完成。运行 `concord skills install` 更新仓库内 Codex 与 Claude 的四个工作流入口，具体规则从当前 CLI 的 skill 读取。

提交前运行 Concord 检查并逐项处理 finding。旧缓存只提供可重建投影，不是事实来源；验证迁移时还要在无缓存副本检查文档、关系与配置。
