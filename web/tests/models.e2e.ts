import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { fixture } from "./support/session";

// @use-case docs/feature/accounts/use-case/manage-server.md
test("获取模型、手动输入、失败脱敏与过期请求隔离", async ({ app, agent, browser, screen }) => {
  const base = fixture("VOICES_TEST_URL");
  const remote = fixture("VOICES_MODEL_TEST_URL");
  await browser.emulateMedia({ colorScheme: "dark" });
  await browser.goto(base);
  await agent.act(
    "用邮箱 models-admin@example.test、用户名 ModelsAdmin、密码 test-browser-password 注册管理员，然后打开服务器设置。",
  );
  let discoveryRequests = 0;
  await browser.route("**/api/v1/admin/llm-models", async (route) => {
    if (route.request.method === "POST") discoveryRequests++;
    await route.continue();
  });
  const fetchModels = async () => {
    const before = discoveryRequests;
    await agent.act(
      "点击获取 LLM 模型一次；空列表或拒绝访问也是预期结果，出现结果后停止，不重试、不测试连接。",
    );
    expect(discoveryRequests - before, "一次操作只允许发出一次模型目录请求").toBe(1);
  };
  await fetchModels();
  await expect(screen.getByRole("status").filter({ hasText: "已获取 2 个模型" })).toBeVisible();
  await expect(screen.getByLabel("搜索模型", { exact: true })).toHaveCount(0);
  await expect(screen.getByLabel("可用模型", { exact: true })).toHaveCount(0);
  await agent.act("展开模型名称的候选列表，暂不选择。");
  await expect(screen.getByRole("option")).toHaveCount(2);
  await agent.act("从候选列表选择 alpha-model。");
  await expect(screen.getByPlaceholder("选择或填写模型 ID", { exact: true })).toHaveValue(
    "alpha-model",
  );
  await agent.act("手动填写模型名称 manual-model，关闭候选列表，保留手动输入。");
  await expect(screen.getByPlaceholder("选择或填写模型 ID", { exact: true })).toHaveValue(
    "manual-model",
  );
  await expect(screen.getByTestId("settings-save-status")).toHaveText("所有修改已保存");
  await expect(screen.getByText("数据库配置已在当前实例生效", { exact: true })).toBeVisible();
  await expect(screen.getByRole("button", { name: "清除 LLM 密钥" })).toBeVisible();
  await agent.act(
    "把 LLM Base URL 改为 {url}、API Key 填为 browser-model-key，等待自动保存，不获取模型。",
    { params: { url: remote + "/v2" } },
  );
  await fetchModels();
  await expect(screen.getByRole("status").filter({ hasText: "已获取 2 个模型" })).toBeVisible();
  await agent.act(
    "把 LLM Base URL 改为 {url}、API Key 填为 browser-model-key，等待自动保存，不获取模型。",
    { params: { url: remote + "/empty" } },
  );
  await expect(screen.getByRole("option")).toHaveCount(0);
  await fetchModels();
  await expect(
    screen.getByText("服务返回空模型列表，请手动填写模型 ID。", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByPlaceholder("选择或填写模型 ID", { exact: true })).toHaveValue(
    "manual-model",
  );
  await agent.act(
    "把 LLM Base URL 改为 {url}、API Key 填为 browser-model-key，等待自动保存，不获取模型。",
    { params: { url: remote + "/error" } },
  );
  await fetchModels();
  await expect(
    browser
      .locator("[data-slot=alert]")
      .filter({ hasText: "模型服务拒绝访问，请检查 API Key 和权限" }),
  ).toBeVisible();
  await expect(
    browser
      .locator("[data-slot=toast-description]")
      .filter({ hasText: "模型服务拒绝访问，请检查 API Key 和权限" }),
  ).toBeVisible();
  await expect(screen.getByText(/private upstream response/)).toHaveCount(0);
  await screen.getByLabel("LLM Base URL", { exact: true }).fill(`${remote}/slow`);
  await screen.getByLabel("LLM API Key", { exact: true }).fill("browser-model-key");
  await screen.getByRole("button", { name: "获取 LLM 模型", exact: true }).click();
  await expect(screen.getByRole("button", { name: "正在获取模型…", exact: true })).toBeVisible();
  await screen.getByLabel("LLM Base URL", { exact: true }).fill(`${remote}/v2`);
  await screen.getByLabel("LLM API Key", { exact: true }).fill("browser-model-key");
  await screen.getByRole("button", { name: "获取 LLM 模型", exact: true }).click();
  await expect(screen.getByRole("status").filter({ hasText: "已获取 2 个模型" })).toBeVisible();
  await agent.act("展开模型名称的候选列表，暂不选择。");
  await expect(screen.getByRole("option")).toHaveCount(2);
  await expect(screen.getByRole("option", { name: "obsolete-model", exact: true })).toHaveCount(0);
  await browser.setViewport({ width: 390, height: 844 });
  await agent.act("从候选列表选择 beta-model。");
  await expect(screen.getByPlaceholder("选择或填写模型 ID", { exact: true })).toHaveValue(
    "beta-model",
  );
  expect(await browser.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await expect(screen.getByTestId("settings-save-status")).toHaveText("所有修改已保存");
  await browser.reload();
  await expect(screen.getByPlaceholder("选择或填写模型 ID", { exact: true })).toHaveValue(
    "beta-model",
  );
});
