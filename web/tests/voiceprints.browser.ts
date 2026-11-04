import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { writeFile } from "node:fs/promises";
import { api, fixture, noOverflow } from "./support/session";

// @use-case docs/feature/people/use-case/recognize-speaker.md
test("人工声纹与后台自动关联即时更新正文", async ({ app, browser, screen }) => {
  await app.open();
  await screen.getByLabel("用户名或邮箱").fill("tester@example.test");
  await screen.getByLabel("密码", { exact: true }).fill("acceptance-password");
  await screen.getByRole("button", { name: "进入工作台" }).click();
  await expect(screen.getByRole("button", { name: "导入录音" }).first()).toBeVisible();
  await browser.goto(`${fixture("VOICES_TEST_URL")}/people/${fixture("VOICES_TEST_PERSON")}`);
  await expect(screen.getByText("已建立 1 份样本，共 16 秒", { exact: true })).toBeVisible();
  await expect(screen.getByRole("button", { name: "从已标识录音更新声纹" })).toBeVisible();
  await browser.setViewport({ width: 375, height: 812 });
  await noOverflow(browser);
  await app.screenshot("手机人物声纹");
  await browser.setViewport({ width: 1440, height: 1000 });
  await browser.goto(
    `${fixture("VOICES_TEST_URL")}/recordings/${fixture("VOICES_TEST_RECORDING")}`,
  );
  await expect(screen.getByText("第一段发言。", { exact: true })).toBeVisible();
  await screen.getByRole("tab", { name: "录音信息", exact: true }).click();
  await screen.getByText("说话人与人物", { exact: true }).click();
  await expect(screen.getByText("正在识别说话人…", { exact: true })).toBeVisible();
  await expect(screen.getByText("自动关联", { exact: true })).toHaveCount(0);
  await browser.evaluate(() => {
    const audio = document.querySelector("audio");
    if (audio) audio.currentTime = 2;
    (window as unknown as { voiceprintAudio: Element | null }).voiceprintAudio = audio;
    return null;
  });
  await browser.locator(".message-more").first().click();
  await screen.getByRole("menuitem", { name: "编辑文字", exact: true }).click();
  await screen.getByLabel("片段文字", { exact: true }).fill("尚未保存的草稿");
  await writeFile(fixture("VOICES_TEST_VOICEPRINT_GATE"), "go");
  await expect(screen.getByText("自动关联", { exact: true })).toBeVisible();
  await expect(
    browser.locator(".transcript-card").getByText("声纹测试人物", { exact: true }).first(),
  ).toBeVisible();
  await expect(screen.getByLabel("片段文字", { exact: true })).toHaveValue("尚未保存的草稿");
  expect(
    await browser.evaluate(
      () =>
        (window as unknown as { voiceprintAudio: Element | null }).voiceprintAudio ===
        document.querySelector("audio"),
    ),
  ).toBe(true);
  expect(
    await browser.evaluate(() => document.querySelector("audio")?.currentTime || 0),
  ).toBeGreaterThanOrEqual(2);
  await browser.keyboard.press("Escape");
  await app.screenshot("后台自动关联完成");
  const version = await (
    await api(browser, `/transcriptions/${fixture("VOICES_TEST_TRANSCRIPTION")}`)
  ).json();
  const label = version.speaker_labels[0];
  expect(label.identity_source).toBe("automatic");
  const cleared = await api(browser, `/speaker-labels/${label.id}`, "PATCH", {
    revision: label.revision,
    person_id: null,
  });
  expect(cleared.status).toBe(200);
  await expect(screen.getByText("自动关联", { exact: true })).toHaveCount(0);
  await expect(
    browser.locator(".transcript-card").getByText("声纹测试人物", { exact: true }),
  ).toHaveCount(0);
  await browser.setViewport({ width: 375, height: 812 });
  await noOverflow(browser);
  await app.screenshot("手机声纹识别与人工解除");
});
