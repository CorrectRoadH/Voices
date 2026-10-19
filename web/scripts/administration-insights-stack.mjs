// Real browser -> Go HTTP -> PostgreSQL; only external LLM HTTP is simulated.
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const base = process.env.VOICES_TEST_URL;
const tid = process.env.VOICES_TEST_TRANSCRIPTION;
const rid = process.env.VOICES_TEST_RECORDING;
const last = process.env.VOICES_TEST_LAST_SEGMENT;
const artifacts = process.env.VOICES_TEST_ARTIFACTS || "/tmp/voices-administration-insights";
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/recordings");
  await page.getByLabel("用户名或邮箱", { exact: true }).fill("tester@example.test");
  await page.getByLabel("密码", { exact: true }).fill("acceptance-password");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.getByRole("link", { name: "站点概览", exact: true }).click();
  await expect(page.getByRole("heading", { name: "站点概览", exact: true })).toBeVisible();
  await expect(page.getByText(/数据库可查询 ·/)).toBeVisible();
  await page.getByRole("link", { name: "账号管理", exact: true }).click();
  // A real admin write should appear in audit history.
  const csrf = (await context.cookies()).find((c) => c.name === "voices_csrf").value;
  const patch = await page.request.patch(base + "/api/v1/admin/registration", {
    headers: { "X-CSRF-Token": csrf, Origin: base },
    data: { registration_open: false },
  });
  expect(patch.status()).toBe(200);
  await page.getByRole("link", { name: "系统日志", exact: true }).click();
  await expect(page.getByRole("heading", { name: "系统日志", exact: true })).toBeVisible();
  await page.getByLabel("事件类型").selectOption("registration_updated");
  await page.getByRole("button", { name: "筛选日志" }).click();
  await expect(
    page.locator("[data-slot=card-title]").filter({ hasText: "修改注册开关" }),
  ).toBeVisible();
  await page.getByLabel("事件类型").selectOption("");
  await page.getByRole("button", { name: "筛选日志" }).click();
  await expect(page.getByRole("button", { name: "下一页" })).toBeEnabled();
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.getByRole("button", { name: "上一页" })).toBeEnabled();
  await page.getByRole("tab", { name: "运行异常", exact: true }).click();
  await page.getByLabel("请求 ID").fill("not-a-uuid");
  await page.getByRole("button", { name: "筛选日志" }).click();
  await expect(page.getByText("ID 格式不正确")).toBeVisible();
  await page.getByLabel("请求 ID").fill("");
  await page.getByRole("button", { name: "筛选日志" }).click();
  await expect(page.getByText("没有匹配的日志")).toBeVisible();
  await page.goto(`${base}/recordings/${rid}/transcriptions/${tid}`);
  await expect(page.getByRole("button", { name: "生成摘要与目录", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "生成摘要与目录", exact: true }).click();
  await expect(page.getByText("会议摘要", { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("navigation", { name: "AI 主题目录" })).toBeVisible();
  await expect(page.locator(`#segment-${last}`)).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "AI 主题目录" })
    .getByRole("button", { name: /决定/ })
    .click();
  await expect(page.locator(`#segment-${last}`)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`segment=${last}`));
  await expect.poll(() => page.locator("audio").evaluate((a) => a.currentTime)).toBeGreaterThan(69);
  expect(await page.locator("audio").evaluate((a) => a.paused)).toBe(true);
  // Editing real content marks the generated result stale.
  const target = page.locator(`#segment-${last}`);
  await target.getByRole("button", { name: "编辑这段文字", exact: true }).click();
  await page.getByLabel("片段文字", { exact: true }).fill("更新后的决定");
  await page.getByRole("button", { name: "保存文字" }).click();
  await expect(page.getByText("转写已更改，结果已过期", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重新生成", exact: true }).click();
  await expect(page.getByText(/模型返回的摘要或章节无法通过校验/)).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "重新生成", exact: true }).click();
  await expect(page.getByText("会议摘要", { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("转写已更改，结果已过期", { exact: true })).toHaveCount(0);
  // Blank timestamps only navigate the text, including on a narrow dark screen.
  await page.getByRole("link", { name: "我的账号", exact: true }).click();
  await page.getByLabel("界面主题", { exact: true }).selectOption("dark");
  await page.goto(`${base}/recordings/${rid}/transcriptions/${tid}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "目录", exact: true }).click();
  await page
    .locator("[data-slot=popover-content]")
    .getByRole("navigation", { name: "AI 主题目录" })
    .getByRole("button", { name: /开场/ })
    .click();
  await expect(page.getByText("该片段没有有效时间，仅定位正文。")).toBeVisible();
  await expect(page.locator('[id^="segment-"]').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: artifacts + "/insights-mobile-dark.png", fullPage: true });
  await page.getByRole("link", { name: "站点概览", exact: true }).click();
  await expect(page.getByText(/数据库可查询 ·/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: artifacts + "/overview-mobile-dark.png", fullPage: true });
  const userContext = await browser.newContext();
  const user = await userContext.newPage();
  await user.goto(base);
  await user.getByLabel("用户名或邮箱", { exact: true }).fill("viewer@example.test");
  await user.getByLabel("密码", { exact: true }).fill("acceptance-password");
  await user.getByRole("button", { name: "进入工作台" }).click();
  await expect(user.getByRole("heading", { name: "录音库", exact: true })).toBeVisible();
  await expect(user.getByRole("navigation", { name: "服务器管理" })).toHaveCount(0);
  expect((await user.request.get(base + "/api/v1/admin/overview")).status()).toBe(403);
  expect((await user.request.get(`${base}/api/v1/transcriptions/${tid}/insights`)).status()).toBe(
    404,
  );
  await user.goto(base + "/admin/logs");
  await expect(user.getByRole("heading", { name: "录音库", exact: true })).toBeVisible();
  await userContext.close();
  expect(errors).toEqual([]);
  console.log(
    "Administration + insights browser acceptance passed: real audit write/filter/pagination, runtime validation, generation/retry/stale, unloaded anchor seek, null timestamps, dark mobile.",
  );
} finally {
  await browser.close();
}
