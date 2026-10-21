import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { api, fixture, login, logout, noOverflow, register } from "./support/session";

// @use-case docs/feature/accounts/use-case/setup-site.md
test("管理员注册后独立初始化、恢复草稿、测试失败修正和普通用户分流", async ({
  app,
  browser,
  screen,
}) => {
  await browser.emulateMedia({ colorScheme: "dark" });
  await app.open();
  await screen.getByLabel("邮箱", { exact: true }).fill("setup@example.test");
  await screen.getByLabel("用户名", { exact: true }).fill("SetupAdmin");
  await screen.getByLabel("密码", { exact: true }).fill("123456");
  await screen.getByRole("button", { name: "创建账号", exact: true }).click();
  await expect(screen.getByRole("heading", { name: "初始化站点", exact: true })).toBeVisible();
  await expect(screen.getByRole("link", { name: "账号管理", exact: true })).toHaveCount(0);
  await expect(screen.getByRole("button", { name: "完成站点初始化", exact: true })).toBeDisabled();
  const auth = await (await api(browser, "/auth/status")).json();
  expect(auth.initialized).toBe(true);
  expect(auth.site_setup_completed).toBe(false);
  expect(auth.registration_open).toBe(false);
  await screen.getByLabel("LLM Base URL", { exact: true }).fill(fixture("VOICES_MODEL_TEST_URL"));
  await screen.getByLabel("LLM API Key", { exact: true }).fill("browser-private-key");
  await screen.getByLabel("模型名称", { exact: true }).fill("invalid-model");
  await expect(screen.getByTestId("settings-save-status")).toHaveText("所有修改已保存");
  await browser.reload();
  await expect(screen.getByLabel("模型名称", { exact: true })).toHaveValue("invalid-model");
  await expect(screen.getByRole("button", { name: "清除 LLM 密钥", exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "退出登录", exact: true }).click();
  await login(screen, "SetupAdmin", "123456");
  await expect(screen.getByRole("heading", { name: "初始化站点", exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "测试 LLM 连接", exact: true }).click();
  await expect(screen.getByText(/LLM 测试失败/).first()).toBeVisible();
  await expect(screen.getByRole("button", { name: "完成站点初始化", exact: true })).toBeDisabled();
  await browser.locator("[data-slot=toast-close]").click();
  await screen.getByRole("button", { name: "获取 LLM 模型", exact: true }).click();
  await expect(screen.getByRole("status").filter({ hasText: "已获取 1 个模型" })).toBeVisible();
  await screen.getByLabel("模型名称", { exact: true }).fill("sample-model");
  await screen.getByRole("option", { name: "sample-model", exact: true }).click();
  await expect(screen.getByTestId("settings-save-status")).toHaveText("所有修改已保存");
  await screen.getByRole("button", { name: "测试 LLM 连接", exact: true }).click();
  await expect(screen.getByText("当前配置测试通过", { exact: true })).toBeVisible();
  await browser.reload();
  await expect(screen.getByText("当前配置测试通过", { exact: true })).toBeVisible();
  await app.screenshot("站点初始化桌面");
  await browser.setViewport({ width: 390, height: 844 });
  await noOverflow(browser);
  await app.screenshot("站点初始化手机");
  await screen.getByRole("button", { name: "完成站点初始化", exact: true }).click();
  await expect(screen.getByRole("heading", { name: "录音库", exact: true })).toBeVisible();
  await logout(browser);
  await screen.getByRole("button", { name: "没有账号？注册", exact: true }).click();
  await register(screen, "normal@example.test", "NormalUser", "123456");
  await expect(screen.getByRole("heading", { name: "初始化站点", exact: true })).toHaveCount(0);
  expect((await api(browser, "/admin/onboarding")).status).toBe(403);
});
