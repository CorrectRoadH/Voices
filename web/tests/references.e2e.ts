import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { api, fixture, noOverflow } from "./support/session";

// @use-case docs/feature/sentence-links/use-case/copy-sentence-link.md
test("Obsidian 多段短引用、登录返回、跨分页与复制取消", async ({ app, agent, browser, screen }) => {
  const base = fixture("VOICES_TEST_URL");
  const path = fixture("VOICES_REFERENCE_PATH");
  const ids: string[] = JSON.parse(fixture("VOICES_REFERENCE_IDS"));
  const tid = fixture("VOICES_REFERENCE_TID");
  const signIn = async () => {
    await agent.act("使用账号 {user}、密码 {password} 登录。", {
      params: { user: "tester@example.test", password: "acceptance-password" },
    });
  };
  await app.open();
  await signIn();
  await expect(screen.getByRole("button", { name: "导入录音" }).first()).toBeVisible();
  await browser.goto(base + path);
  await agent.act("打开第一段以原文开头的消息的更多操作菜单，选择这组发言。");
  await expect(screen.getByText("已选 5 段", { exact: true })).toBeVisible();
  await agent.act("取消当前多选，再打开第一段以原文开头的消息的更多操作菜单，选择多选。");
  await expect(screen.getByText("已选 1 段", { exact: true })).toBeVisible();
  await browser.locator(`#segment-${ids[2]} .segment-text`).click({ modifiers: ["Shift"] });
  await expect(screen.getByText("已选 3 段", { exact: true })).toBeVisible();
  await browser.locator(`#segment-${ids[1]} .segment-text`).click();
  await browser.locator(`#segment-${ids[2]} .segment-text`).click();
  await expect(screen.getByText("已选 1 段", { exact: true })).toBeVisible();
  await agent.act("在多选模式中勾选正文为句子2。的消息，保留第一段的选择。");
  await expect(screen.getByText("已选 2 段", { exact: true })).toBeVisible();
  await expect(browser.locator(".segment-editor")).toHaveCount(0);
  for (let page = 0; page < 4 && !(await browser.locator(`#segment-${ids[110]}`).count()); page++) {
    const count = await browser.locator(".segments > article").count();
    await browser.locator(".segments > article").last().scrollIntoView();
    await expect.poll(() => browser.locator(".segments > article").count()).toBeGreaterThan(count);
  }
  await agent.act("在多选模式中勾选正文为句子110。的消息，保留其他已选段。");
  await expect(screen.getByText("已选 3 段", { exact: true })).toBeVisible();
  await browser.locator(`#segment-${ids[0]} .segment-text`).click({ modifiers: ["Shift"] });
  await expect(screen.getByText("每次最多选择 100 段。", { exact: true }).first()).toBeVisible();
  await expect(screen.getByText("已选 3 段", { exact: true })).toBeVisible();
  // Only the OS clipboard boundary is replaced; generation and persistence are real.
  const denyClipboard = async () => {
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
  };
  await denyClipboard();
  await agent.act("复制当前多选的引用；如果出现手动复制窗口就停下，不要关闭。");
  const manual = screen.getByRole("dialog", { name: "手动复制", exact: true });
  await expect(manual).toBeVisible();
  const markdown = await manual.getByRole("textbox").inputValue();
  expect(markdown).toContain("原文 \\[括号\\] \\*星号\\* &lt;标签&gt; &amp;amp;");
  expect(markdown).not.toContain("来源");
  expect(markdown).not.toContain("transcriptions/");
  expect(markdown.split("〔中间有省略〕")).toHaveLength(3);
  const urls = [...markdown.matchAll(/\]\((https?:\/\/[^)]+)\)/g)].map((match) => match[1]);
  expect(urls).toHaveLength(1);
  expect(markdown).toContain(`> [!quote]+ [查看原录音](${urls[0]})\n`);
  expect(markdown.split("\n").every((line) => line.startsWith(">"))).toBe(true);
  const code = new URL(urls[0]).pathname.split("/").pop()!;
  const reference = await (await api(browser, `/references/${code}`)).json();
  expect(reference.segments.map((segment: { id: string }) => segment.id)).toEqual([
    ids[0],
    ids[2],
    ids[110],
  ]);
  await agent.act("关闭手动复制窗口。");
  await expect(screen.getByText("已选 3 段", { exact: true })).toBeVisible();
  // Desktop selection is outside bubbles; every row remains a selection target.
  expect(
    await browser.evaluate(() =>
      [...document.querySelectorAll(".segment-select-control")].every(
        (control) => !control.closest(".segment-bubble"),
      ),
    ),
  ).toBe(true);
  await browser.setViewport({ width: 375, height: 812 });
  await noOverflow(browser);
  expect(
    await browser.evaluate(() => {
      const toolbar = document.querySelector(".selection-toolbar")!.getBoundingClientRect();
      const player = document.querySelector(".player-panel")!.getBoundingClientRect();
      return toolbar.top >= 0 && toolbar.bottom <= player.top;
    }),
  ).toBe(true);
  await app.screenshot("手机多选工具栏与气泡外勾选");
  await screen.getByRole("button", { name: "复制文字", exact: true }).click();
  await expect(manual).toBeVisible();
  const plain = await manual.getByRole("textbox").inputValue();
  expect(plain).toContain("原文 [括号] *星号* <标签> &amp;");
  expect(plain).not.toContain("/q/");
  expect(plain.split("〔中间有省略〕")).toHaveLength(3);
  await browser.keyboard.press("Escape");
  await expect(screen.getByText("已选 3 段", { exact: true })).toBeVisible();
  // Replace only the OS clipboard boundary to verify successful retry and exit.
  await browser.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as unknown as { copied: string }).copied = text;
        },
      },
    });
    return null;
  });
  await screen.getByRole("button", { name: "复制引用", exact: true }).click();
  await expect(browser.locator(".selection-toolbar")).toHaveCount(0);
  expect(await browser.evaluate(() => (window as unknown as { copied: string }).copied)).toContain(
    "> [!quote]+ [查看原录音]",
  );
  await browser.setViewport({ width: 1440, height: 1000 });
  await api(browser, `/segments/${ids[110]}`, "PATCH", {
    revision: 1,
    edited_text: "复制后校正的末段",
  });
  await api(browser, "/session", "DELETE");
  await browser.goto(urls[0]);
  await signIn();
  await expect(browser).toHaveURL(`${base}${path}?ref=${code}&segment=${ids[0]}`);
  await screen.getByRole("button", { name: "下一引用段", exact: true }).click();
  await expect(browser).toHaveURL(`${base}${path}?ref=${code}&segment=${ids[2]}`);
  await screen.getByRole("button", { name: "下一引用段", exact: true }).click();
  await expect(browser).toHaveURL(`${base}${path}?ref=${code}&segment=${ids[110]}`);
  const last = browser.locator(`#segment-${ids[110]}`);
  await expect(last).toContainText("复制后校正的末段");
  await expect(last).toHaveAttribute("class", /segment-referenced/);
  expect(await browser.evaluate(() => document.querySelector("audio")!.paused)).toBe(true);
  await agent.act("跳到上一引用段。");
  await expect(browser).toHaveURL(`${base}${path}?ref=${code}&segment=${ids[2]}`);
  await expect(browser.locator(`#segment-${ids[2]}`)).toBeVisible();
  await app.screenshot("Obsidian 多段引用返回原文");
  await browser.setViewport({ width: 375, height: 812 });
  await agent.act("跳到下一引用段。");
  await expect(last).toBeVisible();
  await expect
    .poll(() =>
      browser.evaluate((id) => {
        const toolbar = document.querySelector(".reference-tools")!.getBoundingClientRect();
        const target = document.getElementById(`segment-${id}`)!.getBoundingClientRect();
        const player = document.querySelector(".player-panel")!.getBoundingClientRect();
        return toolbar.top >= 0 && toolbar.bottom < target.top && target.bottom < player.top;
      }, ids[110]),
    )
    .toBe(true);
  await noOverflow(browser);
  await app.screenshot("手机多段引用定位");
  await browser.setViewport({ width: 1440, height: 1000 });
  await browser.goto(`${urls[0]}?at=0`);
  await expect(screen.getByText("引用位置无效，无法定位。", { exact: true })).toBeVisible();
  await browser.goto(base + path);
  await agent.act("打开第一段以原文开头的消息的更多操作菜单，选择多选。");
  // A failed create preserves the selection for retry.
  await browser.route(`**/api/v1/transcriptions/${tid}/references`, async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable", message: "测试暂不可用" } }),
    });
  });
  await screen.getByRole("button", { name: "复制引用", exact: true }).click();
  await expect(screen.getByText("已选 1 段", { exact: true })).toBeVisible();
  await expect(
    browser.locator(".reference-toolbar").getByRole("button", { name: "复制引用" }),
  ).toBeEnabled();
  await expect(screen.getByText("测试暂不可用").first()).toBeVisible();
  await browser.unroute(`**/api/v1/transcriptions/${tid}/references`);
  let started = false;
  let release = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await browser.route(`**/api/v1/transcriptions/${tid}/references`, async (route) => {
    started = true;
    await hold;
    try {
      await route.continue();
    } catch {
      /* Navigation may cancel the request. */
    }
  });
  await denyClipboard();
  try {
    await screen.getByRole("button", { name: "复制引用", exact: true }).click();
    await expect.poll(() => started).toBe(true);
    await screen.getByRole("link", { name: "录音库", exact: true }).first().click();
    await expect(screen.getByRole("button", { name: "导入录音" }).first()).toBeVisible();
  } finally {
    release();
  }
  await browser.unroute(`**/api/v1/transcriptions/${tid}/references`);
  await expect(manual).toHaveCount(0);
  // The old UUID URL remains a valid permanent reference.
  await browser.goto(`${base}${path}?segment=${ids[110]}`);
  await expect(last).toBeVisible();
  await expect(last).toContainText("复制后校正的末段");
});
