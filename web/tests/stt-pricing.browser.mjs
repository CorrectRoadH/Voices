// @use-case docs/feature/stt-pricing/use-case/manage-estimates.md
// Deterministic browser acceptance through the real Go/PostgreSQL fixture; no model or paid STT.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
const require = createRequire(import.meta.url);
const engineRequire = createRequire(require.resolve("@e2e-dev/web"));
const { chromium } = engineRequire("playwright-core");
const base = process.env.VOICES_TEST_URL;
assert.ok(base);
const output = ".e2e/stt-pricing";
await mkdir(output, { recursive: true });
let page;
const browser = await chromium.launch({
  executablePath: process.env.E2E_CHROMIUM_EXECUTABLE_PATH || "/run/current-system/sw/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base + "/recordings");
  await page.getByLabel("用户名或邮箱", { exact: true }).fill("tester@example.test");
  await page.getByLabel("密码", { exact: true }).fill("acceptance-password");
  await page.locator('button[form="login-form"]').click();
  await page.getByRole("link", { name: "STT 调用", exact: true }).click();
  await page.getByText("筛选范围汇总", { exact: true }).waitFor();
  await page.getByText("USD 0.000667", { exact: true }).first().waitFor();
  assert.equal(await page.getByText("meeting", { exact: true }).count(), 0);
  const before = await page.evaluate(async () => (await fetch("/api/v1/admin/stt/summary")).json());
  assert.equal(before.totals.completed_estimated_cost_microusd, "667");
  await page.getByLabel("模型 ID", { exact: true }).fill("no-such-model");
  await page.getByRole("button", { name: "筛选", exact: true }).click();
  await page.getByText("没有匹配的 STT 调用", { exact: true }).waitFor();
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await page.getByText("USD 0.000667", { exact: true }).first().waitFor();
  await page.screenshot({ path: `${output}/calls-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 375, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `${output}/calls-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("link", { name: "模型价格", exact: true }).click();
  await page.getByLabel("模型", { exact: true }).selectOption("stt-async-v5");
  await page.getByLabel("基础价（微元/小时）", { exact: true }).fill("invalid");
  await page.getByLabel("说话人区分附加价（微元/小时）", { exact: true }).fill("20000");
  await page.getByLabel("价格来源", { exact: true }).fill("https://soniox.com/pricing");
  await page.getByLabel("核对日期", { exact: true }).fill("2026-11-09");
  const save = page.getByRole("button", { name: "保存新价格版本", exact: true });
  await save.click();
  await page.getByText("参考价须为有效的非负整数微元", { exact: false }).first().waitFor();
  assert.equal(
    await page.getByLabel("基础价（微元/小时）", { exact: true }).inputValue(),
    "invalid",
  );
  await page.getByLabel("基础价（微元/小时）", { exact: true }).fill("200000");
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/admin/stt/prices", async (route) => {
    if (route.request().method() === "POST") await gate;
    await route.continue();
  });
  await save.click();
  await page.waitForFunction(
    () => document.querySelector('button[type="submit"]')?.getAttribute("aria-busy") === "true",
  );
  assert.ok(await save.isDisabled());
  release();
  await page.getByText("参考价已保存", { exact: true }).waitFor();
  await page.getByText("USD 0.200000", { exact: true }).waitFor();
  const after = await page.evaluate(async () => (await fetch("/api/v1/admin/stt/summary")).json());
  assert.deepEqual(after.totals, before.totals);
  await page.getByRole("button", { name: "查看历史版本", exact: true }).click();
  await page.getByText("USD 0.100000", { exact: true }).waitFor();
  await page.screenshot({ path: `${output}/prices-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 375, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `${output}/prices-mobile-dark.png`, fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    "STT 管理真实浏览器验收通过：导航、筛选、汇总、价格失败草稿、保存忙碌、历史快照、375px 和深色；无浏览器异常。",
  );
} catch (error) {
  await page?.screenshot({ path: `${output}/failure.png`, fullPage: true });
  throw error;
} finally {
  await browser.close();
}
