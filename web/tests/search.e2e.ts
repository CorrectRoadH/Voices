import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { fixture, noOverflow } from "./support/session";

// @use-case docs/feature/sentence-links/use-case/copy-sentence-link.md
test("跨页正文搜索与桌面手机句子定位", async ({ app, agent, browser, screen }) => {
  await app.open();
  await agent.act("使用账号 {user}、密码 {password} 登录。", {
    params: { user: "tester@example.test", password: "acceptance-password" },
  });
  const url = fixture("VOICES_TEST_URL") + fixture("VOICES_SEARCH_PATH");
  const targetId = fixture("VOICES_SEARCH_TARGET");
  await browser.goto(url);
  await expect(screen.getByRole("searchbox", { name: "搜索转写正文" })).toBeVisible();
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
  await agent.act("在搜索转写正文中输入 {query}，不要编辑消息正文。", {
    params: { query: "自动思维" },
  });
  await expect(browser.locator(".transcript-search [role=status]")).toContainText("2 个匹配片段");
  await agent.act("点击下一个匹配片段两次，定位到第二个匹配结果。");
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
  await agent.act("将搜索转写正文的查询替换为 {query}。", { params: { query: "auto.[" } });
  await expect(browser.locator(`#segment-${targetId} mark`)).toHaveText("Auto.[");
  await agent.act("将搜索转写正文的查询替换为 {query}。", { params: { query: "不存在的关键词" } });
  await expect(browser.locator(".transcript-search [role=status]")).toContainText("没有匹配片段");
  await expect(screen.getByRole("button", { name: "下一个匹配片段" })).toBeDisabled();
  await agent.act("清除正文搜索。");
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
});
