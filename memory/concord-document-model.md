---
relations:
  - role: supports
    target: docs/engineering/delivery/README.md
---

# Concord 文档模型的接入边界

旧项目有 `concord.config.ts` 但缺少 `docs/taste.md` 时，CLI 可返回 `ProjectNotInitialized`，而 `init` 又因已有配置返回 `ProjectExists`。这种情况需按当前 schema 转换已有文件；重新初始化不能替代内容迁移。

Spec 的路径和唯一一级标题分别作为身份与名称。旧 Memory 可能只在 frontmatter 保存标题，去掉元数据前必须将标题补入正文；不能据此丢弃原有经验。移动页面须同步相对链接与显式源码、测试引用。

本机 Concord 开发版本的文档指引曾写 `C-017`，实际 taste 解析器只接受 `T-N` 与 `{#t-N}`，数字无前导零。用 `concord taste --json` 核对条目及引用，不能只以文件存在或空引用检查通过判断原则生效。

Use Case 步骤的 `{#id}` 前需要空格；缺空格时正文能显示标记，但 `trace gaps` 会把列表识别为未标记。修正后应核对步骤身份与原代码、测试引用。

检查迁移时使用无缓存 Git 副本运行 `check`、`doctor` 与 `trace check`，再比较测试和实现声明数量。检查通过只说明文档与显式关系一致，不能替代数据库、浏览器或原生模型验收。
