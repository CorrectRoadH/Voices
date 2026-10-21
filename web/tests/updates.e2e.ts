import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { fixture } from "./support/session";

// @use-case docs/feature/updates/use-case/check-updates.md
test("管理员检查更新、公告与窄屏展示", async ({ app, browser, screen }) => {
  const base = fixture("VOICES_TEST_URL");
  await browser.goto(base);
  await screen.getByLabel("邮箱", { exact: true }).fill("updates-admin@example.test");
  await screen.getByLabel("用户名", { exact: true }).fill("UpdatesAdmin");
  await screen.getByLabel("密码", { exact: true }).fill("browser-test-password");
  await screen.getByRole("button", { name: "创建账号", exact: true }).click();
  await screen.getByRole("button", { name: "暂不启用 LLM", exact: true }).click();
  await screen.getByRole("link", { name: "服务器设置", exact: true }).click();
  const card = screen.getByTestId("server-updates");
  await expect(card).toBeVisible();
  await expect(card.getByText("尚未检查", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(card.getByText("有新版本 1.10.0", { exact: true })).toBeVisible();
  await expect(card.getByRole("heading", { name: "升级公告 注意", exact: true })).toBeVisible();
  await card.getByText("版本更新日志", { exact: true }).click();
  await expect(
    card.getByText("Release notes <img src=x onerror=alert(1)>", { exact: true }),
  ).toBeVisible();
  await expect(browser.locator("[data-testid=server-updates] img")).toHaveCount(0);
  await app.screenshot("更新页面");
  await browser.setViewport({ width: 390, height: 844 });
  await expect(card).toBeVisible();
  expect(await browser.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await app.screenshot("更新页面");
});
