import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { fixture } from "./support/session";

// @use-case docs/feature/updates/use-case/check-updates.md
test("管理员检查更新、公告与窄屏展示", async ({ app, agent, browser, screen }) => {
  const base = fixture("VOICES_TEST_URL");
  await browser.goto(base);
  await agent.act(
    "用邮箱 updates-admin@example.test、用户名 UpdatesAdmin、密码 browser-test-password 创建管理员账号。",
  );
  await agent.act("暂不启用 LLM，完成初始化后打开服务器设置。");
  const card = screen.getByTestId("server-updates");
  await expect(card).toBeVisible();
  await expect(card.getByText("尚未检查", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(card.getByText("有新版本 1.10.0", { exact: true })).toBeVisible();
  await expect(
    browser
      .locator("[data-testid=server-updates] [data-slot=item-title]")
      .filter({ hasText: "升级公告" }),
  ).toBeVisible();
  await agent.act("展开版本更新日志。");
  await expect(
    screen
      .getByRole("dialog")
      .getByText("Release notes <img src=x onerror=alert(1)>", { exact: true }),
  ).toBeVisible();
  await expect(browser.locator("[role=dialog] img")).toHaveCount(0);
  await app.screenshot("更新页面");
  await browser.setViewport({ width: 390, height: 844 });
  await expect(screen.getByRole("dialog")).toBeVisible();
  expect(await browser.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await app.screenshot("更新页面");
});
