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
  await page.getByRole("link", { name: "调用日志", exact: true }).click();
  assert.equal(await page.getByRole("link", { name: "STT 调用", exact: true }).count(), 0);
  await page.getByLabel("调用类别", { exact: true }).selectOption("ai");
  await page.getByLabel("调用类别", { exact: true }).selectOption("stt");
  await page.getByRole("tab", { name: "STT 费用", exact: true }).click();
  await page.waitForURL("**/admin/calls?view=stt-costs");
  await page.reload();
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
  await page.getByRole("tab", { name: "请求记录", exact: true }).click();
  await page.getByLabel("调用类别", { exact: true }).waitFor();
  await page.goBack();
  await page.getByText("USD 0.000667", { exact: true }).first().waitFor();
  await page.goto(base + "/admin/stt/calls");
  await page.waitForURL("**/admin/calls?view=stt-costs");
  assert.equal(await page.getByRole("link", { name: "模型价格", exact: true }).count(), 0);
  await page.goto(base + "/admin/stt/prices");
  await page.waitForURL("**/admin/calls?view=stt-costs");
  await page.getByText("USD 0.000667", { exact: true }).first().waitFor();
  const after = await page.evaluate(async () => (await fetch("/api/v1/admin/stt/summary")).json());
  assert.deepEqual(after.totals, before.totals);
  await page.setViewportSize({ width: 375, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `${output}/prices-mobile-dark.png`, fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    "STT 管理真实浏览器验收通过：导航、筛选、汇总、无价格管理入口、旧地址重定向、历史快照、375px 和深色；无浏览器异常。",
  );
} catch (error) {
  await page?.screenshot({ path: `${output}/failure.png`, fullPage: true });
  throw error;
} finally {
  await browser.close();
}
