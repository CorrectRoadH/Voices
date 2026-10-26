import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { api, fixture, noOverflow } from "./support/session";

// @use-case docs/feature/accounts/use-case/oidc-login.md
test("管理员配置、跨站回调、账号绑定和本地密码恢复", async ({ app, agent, browser, screen }) => {
  const base = fixture("VOICES_TEST_URL");
  await app.open();
  await expect(screen.getByRole("button", { name: "使用 Test Identity 登录" })).toHaveCount(0);
  await agent.act("用账号 tester@example.test、密码 acceptance-password 登录。");
  await expect(screen.getByRole("link", { name: "服务器设置", exact: true })).toBeVisible();
  await screen.getByRole("link", { name: "服务器设置", exact: true }).click();
  await agent.act(
    "配置统一登录：登录按钮名称 Test Identity，Issuer URL {issuer}，Client ID voices-test，Client Secret test-client-secret；启用统一登录并等待自动保存。",
    { params: { issuer: fixture("VOICES_TEST_ISSUER") } },
  );
  await expect(screen.getByTestId("oidc-save-status")).toHaveText("所有修改已保存");
  await expect
    .poll(async () => (await (await api(browser, "/admin/oidc")).json()).enabled)
    .toBe(true);
  await expect(screen.getByLabel("回调地址")).toHaveValue(base + "/api/v1/auth/oidc/callback");
  const config = await (await api(browser, "/admin/oidc")).json();
  expect(config.client_secret_configured).toBe(true);
  expect(JSON.stringify(config)).not.toContain("test-client-secret");
  await app.screenshot("统一登录站点配置");
  await browser.reload();
  await expect(screen.getByLabel("Issuer URL", { exact: true })).toHaveValue(
    fixture("VOICES_TEST_ISSUER"),
  );
  await expect(screen.getByRole("switch", { name: "启用统一登录" })).toBeChecked();

  // Linking crosses from 127.0.0.1 to localhost and back, exercising real SameSite behavior.
  await browser.goto(base + "/account");
  await screen.getByRole("button", { name: "绑定 Test Identity", exact: true }).click();
  await expect(screen.getByRole("heading", { name: "Test Identity" })).toBeVisible();
  await screen.getByRole("link", { name: "Continue to Voices" }).click();
  await expect(screen.getByRole("heading", { name: "我的账号" })).toBeVisible();
  await expect(screen.getByText("已绑定 Test Identity", { exact: true })).toBeVisible();
  const original = await (await api(browser, "/session")).json();
  expect(original.user.email).toBe("tester@example.test");
  expect(original.user.role).toBe("admin");
  await screen.getByRole("button", { name: "解绑并退出" }).click();
  await expect(screen.getByRole("button", { name: "使用 Test Identity 登录" })).toBeVisible();

  // A previously unlinked external identity creates an ordinary account with its own email.
  await screen.getByRole("button", { name: "使用 Test Identity 登录" }).click();
  await screen.getByRole("link", { name: "Continue to Voices" }).click();
  await expect(screen.getByRole("button", { name: "导入录音" }).first()).toBeVisible();
  const external = await (await api(browser, "/session")).json();
  expect(external.user.email).toBe("external@example.test");
  expect(external.user.role).toBe("user");
  expect(external.user.has_password).toBe(false);
  expect(external.user.id).not.toBe(original.user.id);
  await browser.goto(base + "/account");
  await expect(screen.getByLabel("当前密码", { exact: true })).toHaveCount(0);
  await expect(screen.getByRole("button", { name: "解绑并退出" })).toBeDisabled();
  await app.screenshot("统一登录账号设置密码");
  await agent.act("为当前账号设置本地密码 oidc-browser-password，确认后设置密码并退出。");
  await expect(screen.getByRole("button", { name: "进入工作台" })).toBeVisible();
  await agent.act("用账号 external@example.test、密码 oidc-browser-password 登录。");
  await expect(screen.getByRole("link", { name: "我的账号", exact: true })).toBeVisible();
  await browser.goto(base + "/account");
  await expect(screen.getByLabel("当前密码", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "解绑并退出" }).click();
  await screen.getByRole("button", { name: "使用 Test Identity 登录" }).click();
  await screen.getByRole("link", { name: "Continue to Voices" }).click();
  await expect(
    screen
      .getByText("该邮箱已有账号。请先用原方式登录，再到我的账号绑定统一登录。", { exact: true })
      .first(),
  ).toBeVisible();
  await noOverflow(browser);
});
