// @use-case docs/feature/transcription/use-case/read-transcript.md#global-playback
import assert from "node:assert/strict";

export async function checkGlobalPlayback(page) {
  const audio = page.locator("audio");
  await page.locator(".segment .message-time").nth(1).click();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("link", { name: "人物", exact: true })
    .click();
  await page.waitForFunction(() => {
    const el = document.querySelector("audio");
    return el?.paused && el.currentTime >= 2.49 && el.currentTime < 2.6;
  });
  await page.locator(".player-caption a").click();
  await page.locator(".segment").nth(7).waitFor();
  await audio.evaluate(async (el) => {
    window.originalAudio = el;
    el.currentTime = 2;
    await el.play();
  });
  const start = await audio.evaluate((el) => el.currentTime);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("link", { name: "录音库" })
    .click();
  await page.waitForFunction((time) => {
    const el = document.querySelector("audio");
    return el === window.originalAudio && !el.paused && el.currentTime > time + 0.3;
  }, start);
  await page.locator(".player-caption a").click();
  await page.locator(".segment").nth(7).waitFor();
  assert.ok(
    await audio.evaluate((el) => el === window.originalAudio && !el.paused && el.currentTime > 2),
  );

  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("link", { name: "录音库" })
    .click();
  await page.locator(`a[href="/recordings/${process.env.VOICES_TEST_OTHER_RECORDING}"]`).click();
  await page.getByRole("button", { name: "播放此录音", exact: true }).waitFor();
  assert.ok(await audio.evaluate((el) => el === window.originalAudio && !el.paused));
  assert.ok((await audio.getAttribute("src")).includes(process.env.VOICES_TEST_RECORDING));
  await page.getByRole("button", { name: "播放此录音", exact: true }).click();
  await page.waitForFunction((id) => {
    const el = document.querySelector("audio");
    return el === window.originalAudio && el.src.includes(id) && !el.paused && el.currentTime > 0;
  }, process.env.VOICES_TEST_OTHER_RECORDING);
  assert.equal(await audio.count(), 1);

  // A failed load is recoverable from the global bar without reloading the page.
  await page.route(`**/recordings/${process.env.VOICES_TEST_OTHER_RECORDING}/audio`, (route) =>
    route.abort(),
  );
  await audio.evaluate((el) => el.load());
  await page.locator(".player-panel").getByRole("button", { name: "重试", exact: true }).waitFor();
  await page.unroute(`**/recordings/${process.env.VOICES_TEST_OTHER_RECORDING}/audio`);
  await page.locator(".player-panel").getByRole("button", { name: "重试", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("audio").readyState >= 1);

  await page.getByRole("button", { name: "关闭播放器", exact: true }).click();
  assert.equal(await page.locator(".player-panel:visible").count(), 0);
  assert.ok(
    await page.evaluate(
      () => window.originalAudio.paused && !window.originalAudio.getAttribute("src"),
    ),
  );
  await page.getByRole("button", { name: "播放此录音", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("audio").paused);
  await page.getByRole("button", { name: "录音信息", exact: true }).click();
  await page.getByRole("button", { name: "删除录音", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "确认删除", exact: true })
    .click();
  await page.getByRole("button", { name: "导入录音", exact: true }).waitFor();
  assert.equal(await page.locator(".player-panel:visible").count(), 0);
  assert.ok(
    await page.evaluate(
      () => window.originalAudio.paused && !window.originalAudio.getAttribute("src"),
    ),
  );

  await page.locator(`a[href="/recordings/${process.env.VOICES_TEST_RECORDING}"]`).click();
  await page.locator(".segment").nth(7).waitFor();
  await audio.evaluate(async (el) => {
    await el.play();
  });
  await page.getByRole("button", { name: "我的账号", exact: true }).click();
  await page.getByRole("menuitem", { name: "退出登录", exact: true }).click();
  await page.getByLabel("用户名或邮箱", { exact: true }).waitFor();
  assert.equal(await audio.count(), 0);
  assert.ok(
    await page.evaluate(
      () => window.originalAudio.paused && !window.originalAudio.getAttribute("src"),
    ),
  );
}
