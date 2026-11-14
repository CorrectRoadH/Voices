// @use-case docs/feature/transcription/use-case/read-transcript.md
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
const require = createRequire(import.meta.url);
const engineRequire = createRequire(require.resolve("@e2e-dev/web"));
const { chromium } = engineRequire("playwright-core");
const base = process.env.VOICES_TEST_URL;
const output = ".e2e/chat";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.E2E_CHROMIUM_EXECUTABLE_PATH || "/run/current-system/sw/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
let page;
try {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1200 } });
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base + "/recordings");
  await page.getByLabel("用户名或邮箱", { exact: true }).fill("tester@example.test");
  await page.getByLabel("密码", { exact: true }).fill("acceptance-password");
  await page.locator('button[form="login-form"]').click();
  await page.getByRole("button", { name: "导入录音", exact: true }).waitFor();
  await page.goto(`${base}/recordings/${process.env.VOICES_TEST_RECORDING}`);
  const messages = page.locator(".segment");
  await messages.nth(7).waitFor();
  const layout = await messages.evaluateAll((rows) => {
    const box = (el) => el.getBoundingClientRect();
    return {
      width: box(document.querySelector(".segments")).width,
      bubbles: rows.map((row) => box(row.querySelector(".segment-bubble")).width),
      within: box(rows[1]).top - box(rows[0]).bottom,
      between: box(rows[4]).top - box(rows[3]).bottom,
      firstAvatar: getComputedStyle(rows[0].querySelector(".segment-avatar")).visibility,
      lastAvatar: getComputedStyle(rows[3].querySelector(".segment-avatar")).visibility,
      selfAvatar: getComputedStyle(rows[4].querySelector(".segment-avatar")).display,
      selfName: getComputedStyle(rows[4].querySelector(".segment-top")).display,
    };
  });
  assert.ok(layout.width <= 900 && layout.bubbles.every((width) => width <= 600));
  assert.equal(layout.within, 4);
  assert.equal(layout.between, 12);
  assert.equal(layout.firstAvatar, "hidden");
  assert.equal(layout.lastAvatar, "visible");
  assert.equal(layout.selfAvatar, "none");
  assert.equal(layout.selfName, "none");
  const first = messages.first();
  await page.mouse.move(0, 0);
  assert.equal(
    await first.locator(".message-more").evaluate((el) => getComputedStyle(el).opacity),
    "0",
  );
  await first.locator(".message-time").focus();
  await page.keyboard.press("Tab");
  await page.waitForFunction(() => {
    const more = document.querySelector(".segment .message-more");
    return document.activeElement === more && getComputedStyle(more).opacity === "1";
  });
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "选择这组发言", exact: true }).click();
  assert.equal(await page.locator('.segment [role="checkbox"][aria-checked="true"]').count(), 4);
  await page.getByRole("button", { name: "取消多选", exact: true }).click();
  await first.hover();
  await first.locator(".message-more").click();
  await page.getByRole("menuitem", { name: "复制引用", exact: true }).click();
  // Both automatic clipboard copying and its manual fallback use the real reference API.
  await page.waitForFunction(
    () => document.body.textContent.includes("已复制") || document.querySelector('[role="dialog"]'),
  );
  if (await page.getByRole("dialog").count()) await page.keyboard.press("Escape");
  await first.locator(".message-time").click();
  await page.waitForFunction(() => {
    const audio = document.querySelector("audio");
    return audio && audio.paused && audio.currentTime >= 0.07 && audio.currentTime < 0.5;
  });
  const self = messages.nth(4);
  await self.hover();
  await self.locator(".message-more").click();
  await page.getByRole("menuitem", { name: "批量关联说话人", exact: true }).click();
  await page.getByRole("heading", { name: "选择人物", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${output}/desktop.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: `${output}/desktop-dark.png`, fullPage: true });
  const mobileContext = await browser.newContext({
    viewport: { width: 375, height: 844 },
    isMobile: true,
    hasTouch: true,
    storageState: await context.storageState(),
  });
  const mobile = await mobileContext.newPage();
  await mobile.goto(page.url());
  await mobile.locator(".segment").nth(4).waitFor();
  assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(
    await mobile
      .locator(".message-more")
      .first()
      .evaluate((el) => getComputedStyle(el).opacity),
    "1",
  );
  await mobile.locator(".message-more").first().tap();
  await mobile.getByRole("menuitem", { name: "多选", exact: true }).click();
  await mobile.getByRole("button", { name: "取消多选", exact: true }).click();
  await mobile.screenshot({ path: `${output}/mobile.png`, fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    "聊天浏览器验收通过：连续分组、限宽、姓名头像、键盘菜单、触屏菜单、多选、引用、单句播放和本人关联入口。",
  );
} catch (error) {
  await page?.screenshot({ path: `${output}/failure.png`, fullPage: true });
  throw error;
} finally {
  await browser.close();
}
