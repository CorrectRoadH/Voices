import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, fixture, login, logout, noOverflow } from "./support/session";

// @use-case docs/feature/sentence-links/use-case/copy-sentence-link.md
test("真实上传转写、编辑与人物归属、导出及登录后恢复句子链接", async ({
  app,
  agent,
  browser,
  screen,
}) => {
  const base = fixture("VOICES_TEST_URL");
  await app.open();
  await login(agent, "tester@example.test", "acceptance-password");
  await agent.act("打开导入录音窗口，等待选择文件。");
  await screen.getByLabel("选择音频文件").setInputFiles(fixture("VOICES_TEST_AUDIO"));
  let invalidUploads = 0;
  await browser.route("**/api/v1/recordings", async (route) => {
    if (route.request.method === "POST") invalidUploads++;
    await route.continue();
  });
  await agent.act(
    "展开转写选项，选择 Soniox 的 stt-async-v5 模型、单语言模式，语言代码填 invalid-language，然后开始导入一次。预期校验失败，保留无效选择，不重试。",
  );
  await expect(
    screen.getByText("所选语言不在模型支持范围内，请调整语言或模型。", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByRole("button", { name: /开始导入/ })).toBeDisabled();
  await expect(screen.getByLabel("语言代码")).toHaveValue("invalid-language");
  expect(invalidUploads, "无效选项应在发出上传请求前被拒绝").toBe(0);
  await browser.unroute("**/api/v1/recordings");
  await agent.act("把语言代码改为 zh，点击重新上传，等待导入完成。");
  await expect(screen.getByRole("dialog", { name: "导入录音" })).toHaveCount(0);
  await agent.act("打开刚导入的 browser-meeting 录音详情。");
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
  await agent.act("将第一段转写文字完整替换为 {text}，包括末尾句号，然后保存。", {
    params: { text: "浏览器校正 [保留]。" },
  });
  await expect(target).toContainText("浏览器校正 [保留]。");
  await agent.act("把录音标题改成原位编辑标题并保存。");
  await expect(screen.getByRole("heading", { name: "原位编辑标题", exact: true })).toBeVisible();
  await agent.act(
    "在录音信息里编辑备注，输入内容必须完整等于 {notes}，暂不保存；切换到摘要，再返回录音信息，保留备注编辑状态。",
    { params: { notes: "备注草稿" } },
  );
  await expect(screen.getByLabel("备注", { exact: true })).toHaveValue("备注草稿");
  await agent.act("保存当前录音备注。");
  await expect(screen.getByRole("button", { name: "编辑备注", exact: true })).toHaveText(
    "备注草稿",
  );
  // datetime-local 由浏览器精确设置，避免模型误解秒或时区。
  await screen.getByRole("button", { name: "编辑开始时间" }).click();
  await screen.getByLabel("录音开始时间").fill("2026-10-18T10:20:30");
  await agent.act("保存已填写的录音开始时间。");
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
  await agent.act("编辑第一段浏览器校正 [保留]。的文字，不修改内容，直接保存。");
  await expect(screen.getByLabel("片段文字")).toHaveCount(0);
  expect(unchangedWrites, "无变化的正文不应保存").toBe(0);
  await browser.unroute(`**/api/v1/segments/${segmentId}`);

  await agent.act(
    "通过第一段文字的说话人入口，新建人物，显示名称完整填写为 {name}，并关联给该说话人。",
    { params: { name: "新建批量人物" } },
  );
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

  await agent.act("打开人物列表，进入新建批量人物详情，将其标记为本人。");
  await expect(screen.getByRole("button", { name: "取消本人" })).toBeVisible();
  await agent.act("打开编辑人物窗口，等待选择头像文件。");
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
    await agent.act("保存当前人物资料和已选择的头像。");
    await expect(browser.locator("[data-slot=avatar-image]").first()).toBeVisible();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  await browser.goto(detailUrl);
  await expect(target).toHaveAttribute("class", /segment-self/);
  await expect(browser.locator(`#segment-${segmentId} [data-slot=avatar-image]`)).toBeVisible();
  // 只模拟操作系统剪贴板权限边界；引用仍由实际菜单和产品代码生成。
  await browser.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new DOMException("denied", "NotAllowedError");
        },
      },
    });
    return null;
  });
  await agent.act("打开第一段浏览器校正 [保留]。的更多操作菜单，选择复制引用。");
  const manual = screen.getByRole("dialog", { name: "手动复制", exact: true });
  await expect(manual).toBeVisible();
  const citation = await manual.getByRole("textbox").inputValue();
  expect(citation).toContain("浏览器校正 \\[保留\\]。");
  const referenceCode = citation.match(/\/q\/([A-Za-z0-9_-]{12})\)/)?.[1];
  expect(referenceCode).toBeTruthy();
  const reference = await (await api(browser, `/references/${referenceCode}`)).json();
  expect(reference.transcription_id).toBe(tid);
  expect(reference.segments[0].id).toBe(segmentId);
  await agent.act("关闭手动复制窗口。");
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
  await agent.act("将第一段文字所属的说话人关联到内置人物背景声。");
  await expect(target).toHaveCount(0);
  await agent.act("在录音信息的说话人与人物中，开启显示背景声等内置人物片段。");
  await expect(target).toContainText("背景声");
  await agent.act("关闭显示背景声等内置人物片段。");
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
  await agent.act("打开录音信息里的版本与导出。");
  const download = await browser.waitForDownload(() =>
    screen.getByRole("button", { name: "TXT" }).click(),
  );
  expect(await readFile(download.absolutePath, "utf8"), "导出应包含校正后的正文").toContain(
    "浏览器校正 [保留]。",
  );
  await browser.setViewport({ width: 390, height: 844 });
  await noOverflow(browser);
  await app.screenshot("手机转写详情");

  await logout(agent);
  await browser.goto(deep);
  await login(agent, "tester@example.test", "acceptance-password");
  await expect(browser).toHaveURL(deep);
  await expect(target).toContainText("浏览器校正 [保留]。");
});
