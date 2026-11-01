import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { fixture, login, noOverflow } from "./support/session";

declare global {
  interface Window {
    releaseCallRefresh: (() => void) | null;
  }
}

// @use-case docs/feature/call-logs/use-case/inspect-calls.md
test("个人与管理调用日志共用筛选、详情和分页", async ({ app, agent, browser, screen }) => {
  const base = fixture("VOICES_TEST_URL");
  await browser.goto(base + "/recordings");
  await login(agent, "tester@example.test", "acceptance-password");
  await agent.act("进入处理任务页面，再切换到调用日志标签。");
  await expect(
    screen.getByText("查看自己的 STT 与 AI 调用，调用记录永久保存。", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByText("25 / 7 / 32", { exact: true })).toBeVisible();
  await expect(screen.getByText("HTTP: 401", { exact: true })).toHaveCount(0);
  await expect(screen.getByText("调用 ID", { exact: true })).toBeVisible();
  await expect(screen.getByRole("button", { name: "复制 调用 ID", exact: true })).toBeVisible();
  // Hold only the transport boundary so a fast local response cannot hide the busy state.
  await browser.evaluate(() => {
    const original = window.fetch.bind(window);
    window.releaseCallRefresh = null;
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/calls?")) {
        window.fetch = original;
        await new Promise<void>((resolve) => {
          window.releaseCallRefresh = resolve;
        });
      }
      return original(input, init);
    };
    return true;
  });
  const refresh = browser.locator("body").getByRole("button", { name: "刷新", exact: true });
  await refresh.click();
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  await expect(refresh).toBeDisabled();
  await expect(screen.getByText("25 / 7 / 32", { exact: true })).toBeVisible();
  await expect.poll(() => browser.evaluate(() => window.releaseCallRefresh !== null)).toBe(true);
  await browser.evaluate(() => {
    window.releaseCallRefresh?.();
    return true;
  });
  await expect(refresh).toBeEnabled();
  await expect(browser.locator('[data-slot="badge"]').first()).toHaveText("调用成功");
  await app.screenshot("个人调用日志完整详情");
  await browser.setViewport({ width: 375, height: 844 });
  await noOverflow(browser);
  await browser.evaluate(() => {
    document.querySelector("article")?.scrollIntoView();
    return true;
  });
  await app.screenshot("手机调用详情");
  await browser.setViewport({ width: 1440, height: 1000 });
  await agent.act("通过服务器管理导航进入调用日志页面。");
  await expect(
    screen.getByText("查看全站 STT 与 AI 调用，调用记录永久保存。", { exact: true }),
  ).toBeVisible();
  await agent.act(
    "在账号搜索中输入 calls_viewer，将调用类别筛选为 STT，将调用结果筛选为调用失败。",
  );
  await expect(screen.getByText("HTTP: 401", { exact: true })).toHaveCount(50);
  await agent.act("加载更多调用记录。");
  await expect(screen.getByText("HTTP: 401", { exact: true })).toHaveCount(51);
  await expect(screen.getByText("错误代码：auth · http_status", { exact: true })).toHaveCount(51);
  await expect(browser.locator("main details")).toHaveCount(0);
  for (const theme of ["dark", "light"]) {
    await browser.evaluate((value) => {
      localStorage.setItem("voices.theme", value);
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "voices.theme",
          newValue: value,
          storageArea: localStorage,
        }),
      );
      window.scrollTo(0, 0);
      return true;
    }, theme);
    await expect(browser.locator("html")).toHaveAttribute("data-theme", theme);
    await browser.evaluate(async () => {
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => {})),
      );
      return true;
    });
    await app.screenshot(theme === "dark" ? "桌面深色调用日志" : "桌面浅色调用日志");
  }
  await browser.setViewport({ width: 375, height: 844 });
  await noOverflow(browser);
  await app.screenshot("手机调用日志");
  await agent.act("将模型 ID 筛选为 nonexistent-model。");
  await expect(screen.getByText("没有匹配的调用记录", { exact: true })).toBeVisible();
});
