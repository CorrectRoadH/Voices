import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { fixture, noOverflow } from "./support/session";

// @use-case docs/feature/sentence-links/use-case/copy-sentence-link.md
test("跨页正文搜索与桌面手机句子定位", async ({ app, agent, browser, screen }) => {
  await app.open();
  await agent.act("使用账号 {user}、密码 {password} 登录。", {
    params: { user: "tester@example.test", password: "acceptance-password" },
  });
  const url =
    fixture("VOICES_TEST_URL") + fixture("VOICES_SEARCH_PATH").split("/transcriptions/")[0];
  const targetId = fixture("VOICES_SEARCH_TARGET");
  await browser.goto(url);
  await expect(screen.getByRole("combobox", { name: "搜索转写正文" })).toBeVisible();
  await expect(browser.locator(`#segment-${targetId}`)).toHaveCount(0);
  const initialCount = await browser.locator(".segments > article").count();
  await browser.evaluate(() => {
    const panel = document.querySelector(".transcript-card")!;
    panel.scrollTop = panel.scrollHeight;
    return true;
  });
  await expect
    .poll(() => browser.locator(".segments > article").count())
    .toBeGreaterThan(initialCount);
  await browser.evaluate(() => {
    const probe = { requests: [] as string[], audio: document.querySelector("audio") };
    (window as unknown as { searchProbe: typeof probe }).searchProbe = probe;
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const address =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (address.includes("/segments?")) probe.requests.push(address);
      return original(input, init);
    };
    return true;
  });
  // IME drafts must update the input without rescanning or mutating the transcript.
  const composition = await browser.evaluate(async () => {
    const input = document.querySelector<HTMLInputElement>("#transcript-search")!;
    let mutations = 0;
    const observer = new MutationObserver((entries) => {
      mutations += entries.length;
    });
    observer.observe(document.querySelector(".segments")!, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    input.focus();
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "自动思维",
    );
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: "自动思维",
        inputType: "insertCompositionText",
        isComposing: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    observer.disconnect();
    return {
      value: input.value,
      mutations,
      reads: (window as unknown as { searchProbe: { requests: string[] } }).searchProbe.requests
        .length,
    };
  });
  expect(composition).toEqual({ value: "自动思维", mutations: 0, reads: 0 });
  await browser.evaluate(() => {
    document
      .querySelector("#transcript-search")!
      .dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "自动思维" }));
    return true;
  });
  await expect(browser.locator(".transcript-search [role=status]")).toContainText("2 个匹配片段");
  await expect(browser.locator('[role="option"] mark')).toHaveCount(4);
  await app.screenshot("搜索下拉结果与关键词高亮");
  const searchReads = await browser.evaluate(
    () =>
      (window as unknown as { searchProbe: { requests: string[] } }).searchProbe.requests.length,
  );
  // The first two pages were read by scrolling; search fetches only the last page.
  expect(searchReads).toBe(1);
  await browser.locator('.transcript-search button[aria-label="下一个匹配片段"]').click();
  await expect(browser.locator(".transcript-search [role=status]")).toContainText("1 / 2");
  await screen.getByRole("button", { name: "下一个匹配片段", exact: true }).click();
  await expect(screen.getByRole("combobox", { name: "搜索转写正文" })).toHaveValue("自动思维");
  expect(
    await browser.evaluate(() => {
      const probe = (
        window as unknown as { searchProbe: { audio: HTMLAudioElement; requests: string[] } }
      ).searchProbe;
      return probe.audio === document.querySelector("audio") && probe.requests.length === 1;
    }),
  ).toBe(true);
  await expect(browser).toHaveURL(`${url}?segment=${targetId}`);
  const target = browser.locator(`#segment-${targetId}`);
  await expect(browser.locator(`#segment-${targetId} mark`)).toHaveCount(2);
  const centerDistance = () =>
    browser.evaluate((id) => {
      const element = document.getElementById(`segment-${id}`)!;
      const panel = document.querySelector(".transcript-card")!;
      const rect = element.getBoundingClientRect();
      const toolbar =
        panel.querySelector(".transcript-search")?.getBoundingClientRect().height ?? 0;
      const midpoint =
        getComputedStyle(panel).overflowY === "auto"
          ? panel.getBoundingClientRect().top + (panel.clientHeight + toolbar) / 2
          : Math.min(
              document.querySelector(".player-panel")!.getBoundingClientRect().top,
              innerHeight,
            ) / 2;
      return Math.abs(rect.top + rect.height / 2 - midpoint);
    }, targetId);
  await expect.poll(centerDistance).toBeLessThan(8);
  await expect
    .poll(() =>
      browser.evaluate(
        (id) => document.getElementById(`segment-${id}`)!.getAnimations().length,
        targetId,
      ),
    )
    .toBe(0);
  expect(
    await browser.evaluate(
      (id) =>
        getComputedStyle(document.querySelector(`#segment-${id} .segment-bubble`)!).outlineStyle,
      targetId,
    ),
  ).toBe("none");
  expect(await browser.evaluate(() => document.querySelector("audio")!.paused)).toBe(true);
  await agent.act(
    "点击当前匹配消息“自动思维 Auto.[ 自动思维”末尾的播放图标一次。此步骤只执行点击，播放结束位置由后续精确断言检查。",
  );
  await expect
    .poll(() => browser.evaluate(() => document.querySelector("audio")!.currentTime))
    .toBeCloseTo(11.08, 2);
  expect(await browser.evaluate(() => document.querySelector("audio")!.paused)).toBe(true);
  await app.screenshot("正文搜索定位");
  await screen.getByRole("combobox", { name: "搜索转写正文" }).click();
  await expect(screen.getByRole("option")).toHaveCount(2);
  await browser.keyboard.press("ArrowDown");
  await browser.keyboard.press("Enter");
  await expect(browser.locator(".transcript-search [role=status]")).toContainText("1 / 2");
  await expect(screen.getByRole("combobox", { name: "搜索转写正文" })).toHaveValue("自动思维");
  await screen.getByRole("button", { name: "下一个匹配片段", exact: true }).click();
  await screen.getByRole("combobox", { name: "搜索转写正文" }).click();
  await screen.getByRole("option").first().click();
  await expect(browser.locator(".transcript-search [role=status]")).toContainText("1 / 2");
  await screen.getByRole("combobox", { name: "搜索转写正文" }).click();
  await browser.keyboard.press("ArrowDown");
  await browser.keyboard.press("Shift+Enter");
  await expect(browser.locator(".transcript-search [role=status]")).toContainText("2 / 2");
  await screen.getByRole("combobox", { name: "搜索转写正文" }).fill("auto.[");
  await expect(browser.locator(`#segment-${targetId} mark`)).toHaveCount(1);
  await expect(browser.locator(`#segment-${targetId} mark`)).toHaveText("Auto.[");
  await screen.getByRole("combobox", { name: "搜索转写正文" }).fill("不存在的关键词");
  await expect(browser.locator(".transcript-search [role=status]")).toContainText("没有匹配片段");
  await expect(screen.getByRole("button", { name: "下一个匹配片段" })).toBeDisabled();
  await screen.getByRole("combobox", { name: "搜索转写正文" }).fill("句子");
  await expect(screen.getByRole("option")).toHaveCount(30);
  await screen.getByRole("button", { name: "显示更多结果" }).click();
  await expect(screen.getByRole("option")).toHaveCount(60);
  await browser.keyboard.press("Escape");
  await expect(screen.getByRole("combobox", { name: "搜索转写正文" })).toHaveValue("句子");
  await browser.keyboard.press("Escape");
  await expect(browser.locator("mark")).toHaveCount(0);
  await browser.goto(`${url}?segment=${targetId}`);
  await expect.poll(centerDistance).toBeLessThan(8);
  const checkPrepend = async () => {
    const before = await browser.evaluate(() => {
      const panel = document.querySelector(".transcript-card")!;
      const first = panel.querySelector<HTMLElement>(".segments > article")!;
      if (getComputedStyle(panel).overflowY === "auto") panel.scrollTop = 0;
      else first.scrollIntoView();
      return {
        id: first.id,
        top: first.getBoundingClientRect().top,
        count: panel.querySelectorAll(".segments > article").length,
      };
    });
    await expect
      .poll(() => browser.locator(".segments > article").count())
      .toBeGreaterThan(before.count);
    await expect
      .poll(() =>
        browser.evaluate(
          ({ id, top }) => Math.abs(document.getElementById(id)!.getBoundingClientRect().top - top),
          before,
        ),
      )
      .toBeLessThan(8);
  };
  await checkPrepend();
  await browser.setViewport({ width: 390, height: 844 });
  await browser.goto(`${url}?segment=${targetId}`);
  await expect(target).toBeVisible();
  await expect.poll(centerDistance).toBeLessThan(8);
  await checkPrepend();
  await noOverflow(browser);
  await app.screenshot("手机句子定位");
  await browser.emulateMedia({ colorScheme: "dark" });
  await screen.getByRole("combobox", { name: "搜索转写正文" }).click();
  await screen.getByRole("combobox", { name: "搜索转写正文" }).fill("自动思维");
  await expect(screen.getByRole("option")).toHaveCount(2);
  await noOverflow(browser);
  await expect(screen.getByRole("option").first()).toBeVisible();
  await app.screenshot("手机搜索下拉结果");
});
