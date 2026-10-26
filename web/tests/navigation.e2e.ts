import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { fixture } from "./support/session";

declare global {
  interface Window {
    navigationProbe: {
      requests: string[];
      delay: string | null;
      blocked: boolean;
      release: (() => void) | null;
      fail: string | null;
      audio: HTMLAudioElement | null;
    };
  }
}

// @use-case docs/feature/transcription/use-case/transcribe.md
test("目录复用正文、慢请求保留阅读位置并且最后一次定位获胜", async ({
  app,
  agent,
  browser,
  screen,
}) => {
  await app.open();
  await agent.act("用账号 tester@example.test、密码 acceptance-password 登录。");
  const path = fixture("VOICES_NAV_PATH");
  const url = fixture("VOICES_TEST_URL") + path;
  const ids = JSON.parse(fixture("VOICES_NAV_IDS")) as string[];
  await browser.goto(url);
  await expect(browser.locator(`#segment-${ids[0]}`)).toBeVisible();
  await browser.evaluate(() => {
    const original = window.fetch.bind(window);
    const probe: Window["navigationProbe"] = (window.navigationProbe = {
      requests: [] as string[],
      delay: null as string | null,
      blocked: false,
      release: null as (() => void) | null,
      fail: null as string | null,
      audio: document.querySelector("audio"),
    });
    window.fetch = async (input, init) => {
      const address =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (/\/segments(?:[/?]|$)|\/transcriptions\/[^/?]+(?:\?|$)/.test(address))
        probe.requests.push(address);
      if (probe.delay && address.includes(`anchor_id=${probe.delay}`)) {
        probe.blocked = true;
        await new Promise<void>((resolve) => {
          probe.release = resolve;
        });
      }
      if (probe.fail && address.includes(`anchor_id=${probe.fail}`))
        return new Response("{}", { status: 503 });
      return original(input, init);
    };
    return true;
  });
  const chapter = (name: string) =>
    browser.locator(".detail-aside").getByRole("button", { name, exact: false });
  // The real UI click must reuse both the existing DOM and data.
  await chapter("已加载章节").click();
  await expect(browser).toHaveURL(`${url}?segment=${ids[10]}`);
  expect(await browser.evaluate(() => window.navigationProbe.requests.length)).toBe(0);
  expect(
    await browser.evaluate(() => window.navigationProbe.audio === document.querySelector("audio")),
  ).toBe(true);

  await browser.evaluate((id) => {
    window.navigationProbe.delay = id;
    return true;
  }, ids[110]);
  await chapter("远处章节").click();
  await expect.poll(() => browser.evaluate(() => window.navigationProbe.blocked)).toBe(true);
  await expect(browser.locator(`#segment-${ids[10]}`)).toBeVisible();
  await expect(
    browser.locator(".transcript-card").getByRole("status", { name: "正在加载", exact: true }),
  ).toHaveCount(0);
  await chapter("远处章节").click();
  expect(
    await browser.evaluate(
      (id) =>
        window.navigationProbe.requests.filter((address) => address.includes(`anchor_id=${id}`))
          .length,
      ids[110],
    ),
  ).toBe(1);
  // Cancel the pending far jump by selecting already loaded content.
  await chapter("开场").click();
  await browser.evaluate(() => {
    window.navigationProbe.delay = null;
    window.navigationProbe.release?.();
    return true;
  });
  await expect(browser).toHaveURL(`${url}?segment=${ids[0]}`);
  await expect(browser.locator(`#segment-${ids[0]}`)).toBeVisible();

  await chapter("远处章节").click();
  await expect(browser.locator(`#segment-${ids[110]}`)).toBeVisible();
  await chapter("开场").click();
  await expect(browser.locator(`#segment-${ids[0]}`)).toBeVisible();
  await browser.evaluate(() => {
    window.navigationProbe.requests = [];
    return true;
  });
  await chapter("远处章节").click();
  await expect(browser.locator(`#segment-${ids[110]}`)).toBeVisible();
  expect(await browser.evaluate(() => window.navigationProbe.requests.length)).toBe(0);
  expect(await browser.evaluate(() => document.querySelector("audio")!.paused)).toBe(true);
  await browser.evaluate(() => {
    history.back();
    return true;
  });
  await expect(browser).toHaveURL(`${url}?segment=${ids[0]}`);
  await expect(browser.locator(`#segment-${ids[0]}`)).toBeVisible();
  await browser.evaluate(() => {
    history.forward();
    return true;
  });
  await expect(browser).toHaveURL(`${url}?segment=${ids[110]}`);
  await expect(browser.locator(`#segment-${ids[110]}`)).toBeVisible();
  expect(await browser.evaluate(() => window.navigationProbe.requests.length)).toBe(0);
  await app.screenshot("目录跳转保留正文与缓存");
  // A failed remote jump must not discard the last readable window.
  await browser.evaluate((id) => {
    window.navigationProbe.fail = id;
    return true;
  }, ids[55]);
  await browser.evaluate((id) => {
    history.pushState(null, "", `?segment=${id}`);
    dispatchEvent(new PopStateEvent("popstate"));
    return true;
  }, ids[55]);
  await expect(browser.locator(".transcript-card").getByRole("alert")).toBeVisible();
  await expect(browser.locator(`#segment-${ids[110]}`)).toBeVisible();
});
