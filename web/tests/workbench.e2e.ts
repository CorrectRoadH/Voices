import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, fixture, login, logout, noOverflow } from "./support/session";

// @use-case docs/feature/sentence-links/use-case/copy-sentence-link.md
test("真实上传转写、编辑与人物归属、导出及登录后恢复句子链接", async ({ app, browser, screen }) => {
  const base = fixture("VOICES_TEST_URL");
  await app.open();
  await login(screen, "tester@example.test", "acceptance-password");
  await screen.getByRole("button", { name: "导入录音" }).first().click();
  await screen.getByLabel("选择音频文件").setInputFiles(fixture("VOICES_TEST_AUDIO"));
  await browser.locator("summary").filter({ hasText: "转写选项" }).click();
  await screen.getByLabel("转写服务商").selectOption({ value: "soniox" });
  await screen.getByLabel("模型", { exact: true }).selectOption({ value: "stt-async-v5" });
  await screen.getByLabel("语言模式").selectOption({ value: "single" });
  await screen.getByLabel("语言代码").fill("zh");
  await screen.getByRole("button", { name: "开始导入" }).click();
  await expect(screen.getByRole("dialog", { name: "导入录音" })).toHaveCount(0);
  await browser.locator(".recording-row").first().click();
  const first = browser.locator('[id^="segment-"]').first();
  await expect(first).toBeVisible({ timeout: 30000 });
  await expect(screen.getByText("请先配置 LLM")).toBeVisible();
  await expect(screen.getByRole("button", { name: "生成摘要与目录" })).toHaveCount(0);
  const segmentId = (await first.getAttribute("id"))!.replace("segment-", "");
  const detailUrl = await browser.url();
  const target = browser.locator(`#segment-${segmentId}`);

  // 修改正文保留播放器，校准录音起始时间后仍定位同一句。
  await browser.evaluate(() => {
    (window as unknown as { savedAudio: Element | null }).savedAudio =
      document.querySelector("audio");
    return null;
  });
  await target.getByRole("button", { name: "编辑这段文字" }).click();
  await screen.getByLabel("片段文字").fill("浏览器校正 [保留]。");
  await screen.getByRole("button", { name: "保存文字" }).click();
  await expect(target).toContainText("浏览器校正 [保留]。");
  await screen.getByRole("button", { name: "编辑标题", exact: true }).click();
  await screen.getByLabel("标题", { exact: true }).fill("原位编辑标题");
  await screen
    .getByRole("form", { name: "编辑标题", exact: true })
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(screen.getByRole("heading", { name: "原位编辑标题", exact: true })).toBeVisible();
  await screen.getByRole("tab", { name: "录音信息" }).click();
  await screen.getByRole("button", { name: "编辑备注", exact: true }).click();
  await screen.getByLabel("备注", { exact: true }).fill("备注草稿");
  await screen.getByRole("tab", { name: "摘要", exact: true }).click();
  await screen.getByRole("tab", { name: "录音信息", exact: true }).click();
  await expect(screen.getByLabel("备注", { exact: true })).toHaveValue("备注草稿");
  await screen
    .getByRole("form", { name: "编辑备注", exact: true })
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(screen.getByRole("button", { name: "编辑备注", exact: true })).toHaveText(
    "备注草稿",
  );
  await screen.getByRole("button", { name: "编辑开始时间" }).click();
  await screen.getByLabel("录音开始时间").fill("2026-10-18T10:20:30");
  await screen
    .getByRole("form", { name: "编辑开始时间", exact: true })
    .getByRole("button", { name: "保存" })
    .click();
  await expect(browser.locator(`#segment-${segmentId} .message-time`)).toHaveAttribute(
    "title",
    /10:20:30/,
  );
  expect(
    await browser.evaluate(
      () =>
        (window as unknown as { savedAudio: Element }).savedAudio ===
        document.querySelector("audio"),
    ),
    "编辑不能替换播放器",
  ).toBe(true);

  // 不改正文应视为取消，不应发出保存请求。
  let unchangedWrites = 0;
  await browser.route(`**/api/v1/segments/${segmentId}`, async (route) => {
    if (route.request.method === "PATCH") unchangedWrites++;
    await route.continue();
  });
  await target.getByRole("button", { name: "编辑这段文字" }).click();
  await screen.getByRole("button", { name: "保存文字" }).click();
  await expect(screen.getByLabel("片段文字")).toHaveCount(0);
  expect(unchangedWrites, "无变化的正文不应保存").toBe(0);
  await browser.unroute(`**/api/v1/segments/${segmentId}`);

  await browser.locator(`#segment-${segmentId} .speaker-name-trigger`).click();
  await screen.getByLabel("搜索或新建人物").fill("新建批量人物");
  await screen.getByRole("button", { name: "新建并关联“新建批量人物”" }).click();
  await expect(target).toContainText("新建批量人物");
  const recordings = await (await api(browser, "/recordings")).json();
  const recording = recordings.items[0];
  const tid = recording.active_transcription_id;
  const segments = await (await api(browser, `/transcriptions/${tid}/segments?limit=100`)).json();
  const changed = segments.items.find((item: { id: string }) => item.id === segmentId);
  const linked = segments.items.filter(
    (item: { speaker_label_id: string }) => item.speaker_label_id === changed.speaker_label_id,
  );
  expect(linked.length, "同一说话人应存在多个片段").toBeGreaterThan(1);
  expect(
    linked.every(
      (item: { speaker_name: string; person_id: string }) =>
        item.speaker_name === "新建批量人物" && item.person_id === changed.person_id,
    ),
    "批量人物归属必须持久保存",
  ).toBe(true);

  await screen.getByRole("link", { name: "人物" }).click();
  await screen.getByRole("link", { name: /新建批量人物/ }).click();
  await screen.getByRole("button", { name: "标记为本人" }).click();
  await expect(screen.getByRole("button", { name: "取消本人" })).toBeVisible();
  await screen.getByRole("button", { name: "编辑人物" }).click();
  const directory = await mkdtemp(join(tmpdir(), "voices-e2e-avatar-"));
  try {
    const image = await browser.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 20;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#4378aa";
      context.fillRect(0, 0, 20, 20);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    const path = join(directory, "avatar.png");
    await writeFile(path, Buffer.from(image, "base64"));
    await screen.getByLabel("头像").setInputFiles(path);
    await screen.getByRole("button", { name: "保存人物" }).click();
    await expect(browser.locator("[data-slot=avatar-image]").first()).toBeVisible();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  await browser.goto(detailUrl);
  await expect(target).toHaveAttribute("class", /segment-self/);
  await expect(browser.locator(`#segment-${segmentId} [data-slot=avatar-image]`)).toBeVisible();
  const railTop = await browser.evaluate(
    () => document.querySelector(".sidebar-tabs")!.getBoundingClientRect().top,
  );
  await browser.locator(".segments > article").last().scrollIntoView();
  await expect.poll(() => browser.locator(".segments > article").count()).toBeGreaterThan(50);
  await expect(target).toHaveCount(1);
  expect(
    await browser.evaluate(
      () => document.querySelector(".sidebar-tabs")!.getBoundingClientRect().top,
    ),
  ).toBe(railTop);

  // 背景声过滤和带锚点链接均使用真实片段。
  await browser.goto(detailUrl);
  await browser.locator(`#segment-${segmentId} .speaker-name-trigger`).click();
  await screen.getByRole("button", { name: "背景声 · 内置" }).click();
  await expect(target).toHaveCount(0);
  await screen.getByRole("tab", { name: "录音信息", exact: true }).click();
  await screen.getByText("说话人与人物", { exact: true }).click();
  await screen.getByRole("switch", { name: "显示背景声等内置人物片段" }).check();
  await expect(target).toContainText("背景声");
  await screen.getByRole("switch", { name: "显示背景声等内置人物片段" }).uncheck();
  await expect(target).toHaveCount(0);
  const deep = `${base}/recordings/${recording.id}/transcriptions/${tid}?segment=${segmentId}`;
  await browser.goto(deep);
  await expect(target).toBeVisible();
  await expect
    .poll(() => browser.evaluate(() => document.querySelector("audio")!.readyState))
    .toBeGreaterThan(0);
  expect(
    await browser.evaluate(() => document.querySelector("audio")!.paused),
    "定位句子不应自动播放",
  ).toBe(true);
  await screen.getByRole("tab", { name: "录音信息" }).click();
  await browser.locator("summary").filter({ hasText: "版本与导出" }).click();
  const download = await browser.waitForDownload(() =>
    screen.getByRole("button", { name: "TXT" }).click(),
  );
  expect(await readFile(download.absolutePath, "utf8"), "导出应包含校正后的正文").toContain(
    "浏览器校正 [保留]。",
  );
  await browser.setViewport({ width: 390, height: 844 });
  await noOverflow(browser);
  await app.screenshot("手机转写详情");

  await logout(browser);
  await browser.goto(deep);
  await login(screen, "tester@example.test", "acceptance-password");
  await expect(browser).toHaveURL(deep);
  await expect(target).toContainText("浏览器校正 [保留]。");
});
