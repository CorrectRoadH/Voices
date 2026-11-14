// @use-case docs/feature/insights/use-case/generate-insights.md
// Real upload, PostgreSQL, worker and browser; only external STT/LLM are fake.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
const require = createRequire(import.meta.url);
const engineRequire = createRequire(require.resolve("@e2e-dev/web"));
const { chromium } = engineRequire("playwright-core");
const output = ".e2e/automatic-insights";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.E2E_CHROMIUM_EXECUTABLE_PATH ||
    (existsSync("/run/current-system/sw/bin/chromium")
      ? "/run/current-system/sw/bin/chromium"
      : undefined),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  const manualGenerations = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/insights$/.test(new URL(request.url()).pathname)) {
      manualGenerations.push(request.url());
    }
  });
  await page.goto(process.env.VOICES_TEST_URL + "/recordings");
  await page.getByLabel("用户名或邮箱", { exact: true }).fill("tester@example.test");
  await page.getByLabel("密码", { exact: true }).fill("acceptance-password");
  await page.locator('button[form="login-form"]').click();
  await page.getByRole("button", { name: "导入录音", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导入录音", exact: true });
  await dialog.getByText(/上传后自动转写；已配置 LLM/).waitFor();
  await dialog.locator('input[type="file"]').setInputFiles(process.env.VOICES_TEST_AUDIO);
  await dialog.getByRole("button", { name: "开始导入", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("link").filter({ hasText: "automatic-meeting" }).click();
  await page.getByRole("button", { name: /自动目录/ }).waitFor({ timeout: 60000 });
  await page.getByRole("tab", { name: "摘要", exact: true }).click();
  await page.getByText("自动摘要", { exact: true }).waitFor();
  assert.deepEqual(manualGenerations, []);
  await page.screenshot({ path: `${output}/desktop.png`, fullPage: true });
  await page.reload();
  await page.getByRole("button", { name: /自动目录/ }).waitFor();
  await page.setViewportSize({ width: 375, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `${output}/mobile.png`, fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    "自动摘要真实浏览器验收通过：上传后自动转写和生成，无手动生成请求；刷新保留、375px 无溢出。",
  );
} catch (error) {
  await page?.screenshot({ path: `${output}/failure.png`, fullPage: true });
  throw error;
} finally {
  await browser.close();
}
