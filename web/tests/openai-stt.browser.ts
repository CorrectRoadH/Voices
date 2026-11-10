import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { api, fixture, noOverflow } from "./support/session";

// @use-case docs/feature/transcription/use-case/transcribe.md
test("OpenAI STT 配置、模型选择与直接失败后的收费确认", async ({ app, browser, screen }) => {
  const base = fixture("VOICES_TEST_URL");
  const rid = fixture("VOICES_TEST_RECORDING");
  await app.open();
  await screen.getByLabel("用户名或邮箱").fill("tester@example.test");
  await screen.getByLabel("密码", { exact: true }).fill("acceptance-password");
  await screen.getByRole("button", { name: "进入工作台" }).click();
  await expect(screen.getByRole("button", { name: "导入录音" }).first()).toBeVisible();
  await browser.goto(`${base}/admin/server`);
  await expect(screen.getByText("OpenAI STT", { exact: true })).toBeVisible();
  const key = screen.getByLabel("OpenAI STT API Key", { exact: true });
  await key.fill("browser-openai-key");
  await expect(screen.getByTestId("settings-save-status")).toHaveText("所有修改已保存");
  const saved = await (await api(browser, "/admin/server-settings")).json();
  expect(saved.saved.openai_stt_configured).toBe(true);
  expect(JSON.stringify(saved)).not.toContain("browser-openai-key");
  await browser.reload();
  await expect(
    screen.getByRole("button", { name: "清除 OpenAI STT 密钥", exact: true }),
  ).toBeVisible();
  await noOverflow(browser);
  await browser.evaluate(() => {
    document
      .getElementById("openai-stt-base-url")
      ?.closest('[data-slot="card"]')
      ?.scrollIntoView({ block: "center" });
    return true;
  });
  await app.screenshot("OpenAI STT desktop");
  await browser.setViewport({ width: 375, height: 812 });
  await browser.emulateMedia({ colorScheme: "dark" });
  await browser.evaluate(() => {
    document
      .getElementById("openai-stt-base-url")
      ?.closest('[data-slot="card"]')
      ?.scrollIntoView({ block: "center" });
    return true;
  });
  await noOverflow(browser);
  await app.screenshot("OpenAI STT mobile dark");
  await browser.goto(`${base}/recordings/${rid}`);
  await screen.getByRole("button", { name: "重新转写", exact: true }).click();
  await expect(screen.getByRole("dialog")).toBeVisible();
  await expect(
    screen.getByText("新的转写可能造成重复收费；旧任务继续保留，直接转写不会自动重发。", {
      exact: true,
    }),
  ).toBeVisible();
  await screen.getByLabel("转写服务商", { exact: true }).selectOption({ value: "openai" });
  await screen
    .getByLabel("模型", { exact: true })
    .selectOption({ value: "gpt-4o-transcribe-diarize" });
  await expect(screen.getByRole("button", { name: "开始转写", exact: true })).toBeEnabled();
  await noOverflow(browser);
  await app.screenshot("OpenAI model and duplicate charge confirmation");
  await screen.getByRole("button", { name: "开始转写", exact: true }).click();
  await expect(screen.getByRole("dialog")).toHaveCount(0);
  const versions = await (await api(browser, `/recordings/${rid}/transcriptions`)).json();
  expect(versions.items.length).toBe(2);
});
