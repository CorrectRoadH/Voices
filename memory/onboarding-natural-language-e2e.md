---
format: concord.document/v1
id: onboarding-natural-language-e2e
title: 自然语言 onboarding 与测试边界验收
createdAt: 2026-10-21T09:25:39.202Z
kind: memory
memoryKind: note
state: captured
epoch: 0
promotions: []
history: []
---

# 自然语言 onboarding 验收

2026-10-21，用户确认 tester-army/e2e 应使用自然语言操作，指定 gpt-6.1-sol，并要求标准 dotenv 自动加载、避免 fallback。

## 实现

修正 web/src/lib/api.test.ts 的 409 用例：必须拒绝 Promise 并匹配冲突状态码，不能仅在 catch 内断言。

web/e2e.config.ts 通过 dotenv 加载根目录 .env，使用 E2E_MODEL_BASE_URL、E2E_MODEL、E2E_MODEL_API_KEY 配置 OpenAI Responses 测试代理。缺失配置明确失败，不换模型、不降级为定位器。用户在本地填入凭据，未写入版本控制。CI 声明同名 variables/secret，尚未配置远端仓库值。

onboarding 保留主流程，增加配置测试失效/旧请求返回与清空后跳过/完成失败重试两条独立流程。中文 agent.act 处理用户目标，确定性代码控制竞态与故障，精确断言验证页面及真实 API 状态。每条由 Go 子测试创建独立 schema；被测 LLM 保持 HTTP fake，分别断言 2、3、0 次生成调用。其它 7 条既有浏览器流程仍为定位器写法。

## 验收

隔离 PostgreSQL：TEST_DATABASE_URL 指向本轮创建的本地测试库，E2E_CHROMIUM_EXECUTABLE_PATH 指向系统 Chromium。

- pnpm check：通过（Go 全套、前端 24 项、Worker 10 项、发布 4 项、vet、类型检查、构建）。浏览器和大文件测试仍按原门控单独执行。
- VOICES_BROWSER_TEST=1 go test ./internal/app -run '^TestOnboardingBrowser$' -count=1 -v -timeout=20m：3 条通过，160.8 秒，真实 gpt-6.1-sol agent 共 39 次模型调用。
- 其它七个浏览器入口定向 go test：7 条通过，93.1 秒。
- concord check、concord trace check、actionlint、git diff --check：通过。

首次自然语言运行因代理服务未开通 gpt-6.1-sol 被拒绝；用户开通后同模型通过，没有改用替代模型。测试代理产生真实模型调用，被测应用 STT/LLM 仍 fake。未提交、push、部署或配置远端 secrets。没有创建 worker pane/tab/worktree。
