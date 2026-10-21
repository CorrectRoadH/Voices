import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { api, fixture, login, logout } from "./support/session";

// @use-case docs/feature/insights/use-case/generate-insights.md
test("目录内生成、失败重试、章节定位及手机深色操作", async ({ app, browser, screen }) => {
  const base = fixture("VOICES_TEST_URL");
  const rid = fixture("VOICES_TEST_RECORDING");
  const tid = fixture("VOICES_TEST_TRANSCRIPTION");
  const last = fixture("VOICES_TEST_LAST_SEGMENT");
  await browser.goto(base + "/recordings");
  await screen.getByLabel("用户名或邮箱", { exact: true }).fill("tester@example.test");
  await screen.getByLabel("密码", { exact: true }).fill("acceptance-password");
  await screen.getByRole("button", { name: "进入工作台" }).click();
  await screen.getByRole("link", { name: "站点概览", exact: true }).click();
  await expect(screen.getByRole("heading", { name: "站点概览", exact: true })).toBeVisible();
  await expect(screen.getByText(/数据库可查询 ·/)).toBeVisible();
  await screen.getByRole("link", { name: "账号管理", exact: true }).click();
  // 管理操作写入真实审计记录。
  const patch = await api(browser, "/admin/registration", "PATCH", { registration_open: false });
  expect(patch.status, "管理员修改注册开关应成功").toBe(200);
  await screen.getByRole("link", { name: "系统日志", exact: true }).click();
  await expect(screen.getByRole("heading", { name: "系统日志", exact: true })).toBeVisible();
  await screen.getByLabel("事件类型").selectOption({ value: "registration_updated" });
  await screen.getByRole("button", { name: "筛选日志" }).click();
  await expect(
    browser.locator("[data-slot=card-title]").filter({ hasText: "修改注册开关" }),
  ).toBeVisible();
  await screen.getByLabel("事件类型").selectOption({ value: "" });
  await screen.getByRole("button", { name: "筛选日志" }).click();
  await expect(screen.getByRole("button", { name: "下一页" })).toBeEnabled();
  await screen.getByRole("button", { name: "下一页" }).click();
  await expect(screen.getByRole("button", { name: "上一页" })).toBeEnabled();
  await screen.getByRole("tab", { name: "运行异常", exact: true }).click();
  await screen.getByLabel("请求 ID").fill("not-a-uuid");
  await screen.getByRole("button", { name: "筛选日志" }).click();
  await expect(screen.getByText("ID 格式不正确", { exact: false })).toBeVisible();
  await screen.getByLabel("请求 ID").fill("");
  await screen.getByRole("button", { name: "筛选日志" }).click();
  await expect(screen.getByText("没有匹配的日志", { exact: false })).toBeVisible();
  await browser.goto(`${base}/recordings/${rid}/transcriptions/${tid}`);
  await expect(screen.getByText("AI 摘要与主题目录", { exact: false })).toHaveCount(0);
  await expect(screen.getByText("转写文字", { exact: true })).toHaveCount(0);
  await expect(screen.getByLabel("转写版本", { exact: true })).not.toBeVisible();
  await expect(screen.getByRole("button", { name: "新建转写", exact: true })).not.toBeVisible();
  await screen.getByRole("tab", { name: "录音信息", exact: true }).click();
  await screen.getByText("版本与导出", { exact: true }).click();
  await expect(screen.getByLabel("转写版本", { exact: true })).toBeVisible();
  await expect(screen.getByRole("button", { name: "新建转写", exact: true })).toBeVisible();
  await screen.getByText("说话人与人物", { exact: true }).click();
  await expect(screen.getByRole("button", { name: "管理标签与关联", exact: true })).toBeVisible();
  await expect(screen.getByRole("switch", { name: "显示背景声等内置人物片段" })).toBeVisible();
  await screen.getByRole("tab", { name: "目录", exact: true }).click();

  await expect(screen.getByRole("button", { name: "生成摘要与目录", exact: true })).toBeEnabled();
  await screen.getByRole("button", { name: "生成摘要与目录", exact: true }).click();
  await screen.getByRole("tab", { name: "摘要", exact: true }).click();
  await expect(screen.getByText("会议摘要", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "查看完整摘要", exact: true }).click();
  await expect(screen.getByRole("dialog", { name: "录音摘要", exact: true })).toBeVisible();
  await expect(screen.getByRole("dialog").getByText("会议摘要", { exact: true })).toBeVisible();
  await screen.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();

  await screen.getByRole("tab", { name: "目录", exact: true }).click();
  await expect(screen.getByRole("button", { name: "查看完整摘要" })).not.toBeVisible();
  await expect(screen.getByRole("navigation", { name: "AI 主题目录" })).toBeVisible();
  await expect(browser.locator(`#segment-${last}`)).toHaveCount(0);
  await screen
    .getByRole("navigation", { name: "AI 主题目录" })
    .getByRole("button", { name: /决定/ })
    .click();
  await expect(browser.locator(`#segment-${last}`)).toBeVisible();
  await expect(browser).toHaveURL(new RegExp(`segment=${last}`));
  await expect
    .poll(() => browser.evaluate(() => document.querySelector("audio")!.currentTime))
    .toBeGreaterThan(69);
  expect(await browser.evaluate(() => document.querySelector("audio")!.paused)).toBe(true);
  const initialCount = await browser.locator(".segments > article").count();
  await browser.locator(".segments > article").first().scrollIntoView();
  await expect.poll(() => browser.locator(".segments > article").count()).toBeGreaterThan(initialCount);
  await expect(screen.getByText("向上滚动加载更多", { exact: true })).toHaveCount(0);
  await browser.evaluate(() => { window.scrollTo(0, 0); document.querySelector(".transcript-card")!.scrollTop = 0; return null; });
  expect(await browser.evaluate(() => Math.abs(
    document.querySelector(".segments")!.getBoundingClientRect().top -
    document.querySelector(".sidebar-tabs")!.getBoundingClientRect().top,
  ))).toBeLessThan(2);

  // 编辑正文后摘要过期，在目录内直接重新生成和重试。
  const target = browser.locator(`#segment-${last}`);
  await target.getByRole("button", { name: "编辑这段文字", exact: true }).click();
  await screen.getByLabel("片段文字", { exact: true }).fill("更新后的决定");
  await screen.getByRole("button", { name: "保存文字" }).click();
  await expect(screen.getByText("转写已更改，结果已过期", { exact: true })).toBeVisible();
  await screen.getByRole("tab", { name: "摘要", exact: true }).click();
  await screen.getByRole("button", { name: "重新生成", exact: true }).click();
  await expect(screen.getByText("摘要与目录生成失败", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(screen.getByText("尚未生成主题目录", { exact: true })).toHaveCount(0);
  await app.screenshot("目录失败与重试");
  await screen.getByRole("button", { name: "重试", exact: true }).click();
  await screen.getByRole("tab", { name: "摘要", exact: true }).click();
  await expect(screen.getByText("会议摘要", { exact: true })).toBeVisible();
  await expect(screen.getByText("转写已更改，结果已过期", { exact: true })).toHaveCount(0);
  // 手机深色模式：空时间章节只定位正文。
  await screen.getByRole("link", { name: "我的账号", exact: true }).click();
  await screen.getByLabel("界面主题", { exact: true }).selectOption({ value: "dark" });
  await browser.goto(`${base}/recordings/${rid}/transcriptions/${tid}`);
  await browser.setViewport({ width: 390, height: 844 });
  await screen.getByRole("button", { name: "目录", exact: true }).click();
  await browser.locator("[data-slot=popover-content]").getByRole("tab", { name: "摘要", exact: true }).click();
  await browser
    .locator("[data-slot=popover-content]")
    .getByRole("button", { name: "重新生成" })
    .click();
  await expect(browser.locator("[data-slot=popover-content]").getByRole("button", { name: "查看完整摘要" })).toBeVisible();
  await browser.locator("[data-slot=popover-content]").getByRole("tab", { name: "目录", exact: true }).click();
  await expect(
    browser.locator("[data-slot=popover-content]").getByRole("navigation", { name: "AI 主题目录" }),
  ).toBeVisible();
  await browser
    .locator("[data-slot=popover-content]")
    .getByRole("navigation", { name: "AI 主题目录" })
    .getByRole("button", { name: /开场/ })
    .click();
  await expect(
    screen.getByText("该片段没有有效时间，仅定位正文。", { exact: false }),
  ).toBeVisible();
  await expect(browser.locator('[id^="segment-"]').first()).toBeVisible();
  expect(await browser.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await app.screenshot("手机深色目录");
  await screen.getByRole("link", { name: "站点概览", exact: true }).click();
  await expect(screen.getByText(/数据库可查询 ·/)).toBeVisible();
  expect(await browser.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await app.screenshot("手机站点概览");

  // 普通账号不能读取管理员录音，页面和 API 均拒绝。
  await logout(browser);
  await login(screen, "viewer@example.test", "acceptance-password");
  await expect(screen.getByRole("heading", { name: "录音库" })).toBeVisible();
  await expect(screen.getByRole("navigation", { name: "服务器管理" })).toHaveCount(0);
  expect((await api(browser, "/admin/overview")).status).toBe(403);
  expect((await api(browser, `/transcriptions/${tid}/insights`)).status).toBe(404);
  await browser.goto(base + "/admin/logs");
  await expect(screen.getByRole("heading", { name: "录音库" })).toBeVisible();
});
