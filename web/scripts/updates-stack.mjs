// Real UI, Go handlers and PostgreSQL; only the remote update service is a fixture.
import { chromium, expect } from "@playwright/test";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.env.VOICES_TEST_URL);
  await page.getByLabel("邮箱", { exact: true }).fill("updates-admin@example.test");
  await page.getByLabel("用户名", { exact: true }).fill("UpdatesAdmin");
  await page.getByLabel("密码", { exact: true }).fill("browser-test-password");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.getByRole("link", { name: "服务器设置", exact: true }).click();
  const card = page.getByTestId("server-updates");
  await expect(card).toBeVisible();
  await expect(card.getByText("尚未检查", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(card.getByText("有新版本 1.10.0", { exact: true })).toBeVisible();
  await expect(card.getByRole("heading", { name: "升级公告 注意", exact: true })).toBeVisible();
  await card.getByText("版本更新日志", { exact: true }).click();
  await expect(
    card.getByText("Release notes <img src=x onerror=alert(1)>", { exact: true }),
  ).toBeVisible();
  await expect(card.locator("img")).toHaveCount(0);
  await page.screenshot({
    path: process.env.VOICES_UPDATES_SCREENSHOT || "/tmp/voices-updates-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/voices-updates-mobile.png", fullPage: true });
  expect(errors).toEqual([]);
  console.log(
    "Updates browser acceptance passed: real administrator, manual check, release notes, announcement, inert HTML, mobile.",
  );
} finally {
  await browser.close();
}
