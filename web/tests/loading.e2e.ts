import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { fixture, api } from "./support/session";

declare global {
  interface Window {
    loadingProbe: {
      requests: string[];
      block: boolean;
      fail: boolean;
      release: (() => void) | null;
    };
  }
}
// @feature docs/feature/appearance/README.md
test("筛选保留内容、分页刷新全范围、搜索与名称复用、后台暂停轮询", async ({ app, browser }) => {
  await app.open();
  await browser.locator("#email").fill("tester@example.test");
  await browser.locator("#password").fill("acceptance-password");
  await browser.locator('button[form="login-form"]').click();
  const base = fixture("VOICES_TEST_URL");
  await expect(browser.locator(".recording-row")).toHaveCount(30);
  await browser.evaluate(() => {
    const original = window.fetch.bind(window);
    const probe = (window.loadingProbe = {
      requests: [] as string[],
      block: false,
      fail: false,
      release: null as (() => void) | null,
    });
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      probe.requests.push(url);
      if (probe.fail && url.includes("/recordings?")) return new Response("{}", { status: 503 });
      if (probe.block && url.includes("/recordings?"))
        await new Promise<void>((resolve) => {
          probe.release = resolve;
        });
      return original(input, init);
    };
    return true;
  });
  await browser.locator("body").getByRole("button", { name: "加载更多", exact: true }).click();
  await expect(browser.locator(".recording-row")).toHaveCount(36);
  await browser.evaluate(() => {
    window.loadingProbe.requests = [];
    window.loadingProbe.block = true;
    return true;
  });
  await browser.locator("#recording-search").fill("加载验收 1");
  await expect.poll(() => browser.evaluate(() => !!window.loadingProbe.release)).toBe(true);
  await expect(browser.locator(".recording-row")).toHaveCount(36);
  await expect(browser.locator("body").getByText("正在更新…", { exact: true })).toBeVisible();
  expect(
    await browser.evaluate(() =>
      window.loadingProbe.requests
        .filter((url) => url.includes("/recordings?"))
        .every((url) => !url.includes("cursor=")),
    ),
  ).toBe(true);
  await browser.evaluate(() => {
    window.loadingProbe.block = false;
    window.loadingProbe.release?.();
    return true;
  });
  await expect(browser.locator(".recording-row")).toHaveCount(11);
  await browser.evaluate(() => {
    window.loadingProbe.fail = true;
    return true;
  });
  await browser.locator("#recording-search").fill("加载验收 2");
  await expect(
    browser.locator("body").getByText("筛选未更新，显示上次结果。", { exact: true }),
  ).toBeVisible();
  await expect(browser.locator(".recording-row")).toHaveCount(11);
  await expect(browser.locator("body").getByText("正在更新…", { exact: true })).toHaveCount(0);
  await browser.evaluate(() => {
    window.loadingProbe.fail = false;
    return true;
  });
  await browser.locator("body").getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(
    browser.locator("body").getByText("筛选未更新，显示上次结果。", { exact: true }),
  ).toHaveCount(0);
  await expect(browser.locator(".recording-row").first()).toContainText("加载验收 2");
  // Navigate through SPA links to keep the network observer installed.
  await browser.locator("body").getByRole("link", { name: "处理任务", exact: true }).click();
  await browser.locator("body").getByRole("button", { name: "加载更多", exact: true }).click();
  const result = await api(
    browser,
    `/recordings/${fixture("VOICES_LOADING_JOB_RECORDING")}`,
    "DELETE",
  );
  expect(result.ok, await result.text()).toBe(true);
  await browser.evaluate(() => {
    window.loadingProbe.requests = [];
    return true;
  });
  await browser.locator("body").getByRole("button", { name: "刷新", exact: true }).click();
  await expect(
    browser.locator('[data-slot="card"]').getByText("已取消", { exact: true }),
  ).toHaveCount(55);
  await expect
    .poll(() =>
      browser.evaluate(
        () => window.loadingProbe.requests.filter((url) => url.includes("/jobs?")).length,
      ),
    )
    .toBeGreaterThanOrEqual(2);
  await browser.locator("body").getByRole("tab", { name: "调用日志", exact: true }).click();
  await expect(
    browser.locator("body").getByRole("button", { name: "加载更多", exact: true }),
  ).toBeVisible();
  // Wait until the first recording title lookup is completed before appending the second page.
  await expect
    .poll(() =>
      browser.evaluate(() =>
        window.loadingProbe.requests.some((url) => /\/recordings\/[^/?]+$/.test(url)),
      ),
    )
    .toBe(true);
  await browser.evaluate(() => {
    window.loadingProbe.requests = [];
    return true;
  });
  await browser.locator("body").getByRole("button", { name: "加载更多", exact: true }).click();
  await expect(
    browser.locator("body").getByRole("button", { name: "加载更多", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      browser.evaluate(
        () =>
          window.loadingProbe.requests.filter((url) => /\/recordings\/[^/?]+$/.test(url)).length,
      ),
    )
    .toBe(1);
  expect(
    await browser.evaluate(
      (id) =>
        window.loadingProbe.requests.filter((url) => url.endsWith(`/recordings/${id}`)).length,
      fixture("VOICES_LOADING_RID"),
    ),
  ).toBe(0);
  await browser.goto(
    `${base}/recordings/${fixture("VOICES_LOADING_RID")}/transcriptions/${fixture("VOICES_LOADING_TID")}`,
  );
  await expect(browser.locator("#transcript-search")).toBeVisible();
  await browser.evaluate(() => {
    const original = window.fetch.bind(window);
    window.loadingProbe = { requests: [], block: false, fail: false, release: null };
    window.fetch = (input, init) => {
      const url = String(input);
      window.loadingProbe.requests.push(url);
      return original(input, init);
    };
    return true;
  });
  await browser.locator("#transcript-search").fill("片段");
  await expect
    .poll(() =>
      browser.evaluate(
        () => !!document.querySelector(".transcript-search")?.textContent?.includes("正在搜索…"),
      ),
    )
    .toBe(false);
  const initial = await browser.evaluate(
    () => window.loadingProbe.requests.filter((url) => url.includes("/segments?")).length,
  );
  expect(initial).toBeGreaterThan(0);
  await browser.locator("body").getByRole("button", { name: "清除正文搜索", exact: true }).click();
  await browser.locator("#transcript-search").fill("其他");
  await expect(browser.locator("body").getByText("正在搜索…", { exact: true })).toHaveCount(0);
  expect(
    await browser.evaluate(
      () => window.loadingProbe.requests.filter((url) => url.includes("/segments?")).length,
    ),
  ).toBe(initial);
  await browser.locator("#transcript-search").fill("句子110");
  await expect(browser.locator(".transcript-search [role=status]")).toContainText("1 个匹配片段");
  await browser
    .locator("body")
    .getByRole("button", { name: "下一个匹配片段", exact: true })
    .click();
  await expect(browser.locator(`#segment-${fixture("VOICES_LOADING_TARGET")}`)).toBeVisible();
  await browser.evaluate(() => {
    window.loadingProbe.requests = [];
    return true;
  });
  await new Promise((resolve) => setTimeout(resolve, 7500));
  expect(await browser.evaluate(() => window.loadingProbe.requests.length)).toBe(0);
  // Browser visibility event is the external boundary; production polling code remains unchanged.
  await browser.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    window.loadingProbe.requests = [];
    return true;
  });
  await new Promise((resolve) => setTimeout(resolve, 7500));
  expect(await browser.evaluate(() => window.loadingProbe.requests.length)).toBe(0);
  await browser.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
    return true;
  });
  await expect
    .poll(() =>
      browser.evaluate(
        () =>
          window.loadingProbe.requests.filter((url) => /\/jobs\?|\/recordings\//.test(url)).length,
      ),
    )
    .toBeGreaterThanOrEqual(3);
  await app.screenshot("加载与缓存验收");
});
