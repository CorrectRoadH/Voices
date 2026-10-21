import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { fixture } from "./support/session";

// @use-case docs/feature/accounts/use-case/manage-server.md
test("获取模型、手动输入、失败脱敏与过期请求隔离", async ({ app, browser, screen }) => {
  const base = fixture("VOICES_TEST_URL");
  const remote = fixture("VOICES_MODEL_TEST_URL");
  await browser.emulateMedia({ colorScheme: "dark" });
  await browser.goto(base);
  await screen.getByLabel("邮箱", { exact: true }).fill("models-admin@example.test");
  await screen.getByLabel("用户名", { exact: true }).fill("ModelsAdmin");
  await screen.getByLabel("密码", { exact: true }).fill("test-browser-password");
  await screen.getByRole("button", { name: "创建账号", exact: true }).click();
  await screen.getByRole("link", { name: "服务器设置", exact: true }).click();
  const fetchModels = () =>
    screen.getByRole("button", { name: "获取 LLM 模型", exact: true }).click();
  await fetchModels();
  await expect(screen.getByRole("status").filter({ hasText: "已获取 2 个模型" })).toBeVisible();
  await expect(screen.getByLabel("搜索模型", { exact: true })).toHaveCount(0);
  await expect(screen.getByLabel("可用模型", { exact: true })).toHaveCount(0);
  await screen.getByPlaceholder("选择或填写模型 ID", { exact: true }).click();
  await expect(screen.getByRole("option")).toHaveCount(2);
  await screen.getByRole("option", { name: "alpha-model", exact: true }).click();
  await expect(screen.getByPlaceholder("选择或填写模型 ID", { exact: true })).toHaveValue(
    "alpha-model",
  );
  await screen.getByPlaceholder("选择或填写模型 ID", { exact: true }).fill("manual-model");
  await browser.keyboard.press("Escape");
  await expect(screen.getByPlaceholder("选择或填写模型 ID", { exact: true })).toHaveValue(
    "manual-model",
  );
  await expect(screen.getByTestId("settings-save-status")).toHaveText("所有修改已保存");
  await expect(screen.getByText("数据库配置已在当前实例生效", { exact: true })).toBeVisible();
  await expect(screen.getByRole("button", { name: "清除 LLM 密钥" })).toBeVisible();
  await screen.getByLabel("LLM Base URL", { exact: true }).fill(`${remote}/v2`);
  await screen.getByLabel("LLM API Key", { exact: true }).fill("browser-model-key");
  await fetchModels();
  await expect(screen.getByRole("status").filter({ hasText: "已获取 2 个模型" })).toBeVisible();
  await screen.getByLabel("LLM Base URL", { exact: true }).fill(`${remote}/empty`);
  await screen.getByLabel("LLM API Key", { exact: true }).fill("browser-model-key");
  await expect(screen.getByRole("option")).toHaveCount(0);
  await fetchModels();
  await expect(
    screen.getByText("服务返回空模型列表，请手动填写模型 ID。", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByPlaceholder("选择或填写模型 ID", { exact: true })).toHaveValue(
    "manual-model",
  );
  await screen.getByLabel("LLM Base URL", { exact: true }).fill(`${remote}/error`);
  await screen.getByLabel("LLM API Key", { exact: true }).fill("browser-model-key");
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
  await browser.locator("[data-slot=toast-close]").click();
  await expect(screen.getByText(/private upstream response/)).toHaveCount(0);
  await screen.getByLabel("LLM Base URL", { exact: true }).fill(`${remote}/slow`);
  await screen.getByLabel("LLM API Key", { exact: true }).fill("browser-model-key");
  await fetchModels();
  await expect(screen.getByRole("button", { name: "正在获取模型…", exact: true })).toBeVisible();
  await screen.getByLabel("LLM Base URL", { exact: true }).fill(`${remote}/v2`);
  await screen.getByLabel("LLM API Key", { exact: true }).fill("browser-model-key");
  await fetchModels();
  await expect(screen.getByRole("status").filter({ hasText: "已获取 2 个模型" })).toBeVisible();
  await screen.getByPlaceholder("选择或填写模型 ID", { exact: true }).click();
  await expect(screen.getByRole("option")).toHaveCount(2);
  await expect(screen.getByRole("option", { name: "obsolete-model", exact: true })).toHaveCount(0);
  await browser.setViewport({ width: 390, height: 844 });
  await screen.getByRole("option", { name: "beta-model", exact: true }).click();
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
