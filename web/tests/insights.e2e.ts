import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { api, fixture, login, logout } from "./support/session";

// @use-case docs/feature/insights/use-case/generate-insights.md
test("目录内生成、失败重试、章节定位及手机深色操作", async ({ app, agent, browser, screen }) => {
  const base = fixture("VOICES_TEST_URL");
  const rid = fixture("VOICES_TEST_RECORDING");
  const tid = fixture("VOICES_TEST_TRANSCRIPTION");
  const last = fixture("VOICES_TEST_LAST_SEGMENT");
  await browser.goto(base + "/recordings");
  await login(agent, "tester@example.test", "acceptance-password");
  await browser.goto(`${base}/recordings/${rid}/transcriptions/${tid}`);
  await expect(screen.getByText("AI 摘要与主题目录", { exact: false })).toHaveCount(0);
  await expect(screen.getByText("转写文字", { exact: true })).toHaveCount(0);
  await expect(screen.getByLabel("转写版本", { exact: true })).not.toBeVisible();
  await expect(screen.getByRole("button", { name: "新建转写", exact: true })).not.toBeVisible();
  await agent.act("打开录音信息，展开版本与导出。");
  await expect(screen.getByLabel("转写版本", { exact: true })).toBeVisible();
  await expect(screen.getByRole("button", { name: "新建转写", exact: true })).toBeVisible();
  await agent.act("展开说话人与人物。");
  await expect(screen.getByRole("button", { name: "管理标签与关联", exact: true })).toBeVisible();
  await expect(screen.getByRole("switch", { name: "显示背景声等内置人物片段" })).toBeVisible();
  await agent.act("切换到目录标签。");

  await expect(screen.getByRole("button", { name: "生成摘要与目录", exact: true })).toBeEnabled();
  await agent.act("生成摘要与目录，只点击一次并等待生成完成。");
  await agent.act("切换到摘要标签。");
  await expect(screen.getByText("会议摘要", { exact: true })).toBeVisible();
  await agent.act("查看完整摘要。");
  await expect(screen.getByRole("dialog", { name: "录音摘要", exact: true })).toBeVisible();
  await expect(screen.getByRole("dialog").getByText("会议摘要", { exact: true })).toBeVisible();
  await agent.act("关闭录音摘要对话框。");

  await agent.act("切换到目录标签。");
  await expect(screen.getByRole("button", { name: "查看完整摘要" })).not.toBeVisible();
  await expect(screen.getByRole("navigation", { name: "AI 主题目录" })).toBeVisible();
  await expect(browser.locator(`#segment-${last}`)).toHaveCount(0);
  await agent.act("点击主题目录中的决定章节，定位正文。");
  await expect(browser.locator(`#segment-${last}`)).toBeVisible();
  await expect(browser).toHaveURL(new RegExp(`segment=${last}`));
  await expect
    .poll(() => browser.evaluate(() => document.querySelector("audio")!.currentTime))
    .toBeGreaterThan(69);
  expect(await browser.evaluate(() => document.querySelector("audio")!.paused)).toBe(true);
  await browser.locator(".segments > article").first().scrollIntoView();
  await expect(browser.locator(".segments > article")).toHaveCount(75);
  await expect(screen.getByText("向上滚动加载更多", { exact: true })).toHaveCount(0);
  await browser.evaluate(() => {
    window.scrollTo(0, 0);
    document.querySelector(".transcript-card")!.scrollTop = 0;
    return null;
  });
  expect(
    await browser.evaluate(() =>
      Math.abs(
        document.querySelector(".segments")!.getBoundingClientRect().top -
          document.querySelector(".sidebar-tabs")!.getBoundingClientRect().top,
      ),
    ),
  ).toBeLessThan(2);

  // 编辑正文后摘要过期，在目录内直接重新生成和重试。
  await agent.act("将最后一个片段的文字编辑为更新后的决定，并保存文字。");
  await expect(screen.getByText("转写已更改，结果已过期", { exact: true })).toBeVisible();
  await agent.act("切换到摘要标签。");
  await agent.act("重新生成摘要，只尝试一次。预期生成失败，看到失败后停止，不要重试。");
  await expect(screen.getByText("摘要与目录生成失败", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(screen.getByText("尚未生成主题目录", { exact: true })).toHaveCount(0);
  await app.screenshot("目录失败与重试");
  await agent.act("重试生成摘要与目录一次，等待完成。");
  await agent.act("切换到摘要标签。");
  await expect(screen.getByText("会议摘要", { exact: true })).toBeVisible();
  await expect(screen.getByText("转写已更改，结果已过期", { exact: true })).toHaveCount(0);
  // 手机深色模式：空时间章节只定位正文。
  await agent.act("进入我的账号，将界面主题设为深色。");
  await browser.goto(`${base}/recordings/${rid}/transcriptions/${tid}`);
  await browser.setViewport({ width: 390, height: 844 });
  await agent.act("打开手机界面的目录面板。");
  await agent.act("切换到手机目录面板的摘要页，重新生成摘要一次，等待完成。");
  await expect(
    browser.locator("[data-slot=popover-content]").getByRole("button", { name: "查看完整摘要" }),
  ).toBeVisible();
  await agent.act("切换到手机面板中的目录标签。");
  await expect(
    browser.locator("[data-slot=popover-content]").getByRole("navigation", { name: "AI 主题目录" }),
  ).toBeVisible();
  // 提示会自动消失，在自然语言操作期间观察，避免等待模型收尾后才检查。
  await Promise.all([
    expect(screen.getByText("该片段没有有效时间，仅定位正文。", { exact: false })).toBeVisible({
      timeout: 30000,
    }),
    agent.act("点击主题目录中的开场章节。"),
  ]);
  await expect(browser.locator('[id^="segment-"]').first()).toBeVisible();
  expect(await browser.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await app.screenshot("手机深色目录");
  await agent.act("进入站点概览页面。");
  await expect(screen.getByText(/数据库可查询 ·/)).toBeVisible();
  expect(await browser.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await app.screenshot("手机站点概览");

  // 普通账号不能读取管理员录音，页面和 API 均拒绝。
  await logout(agent);
  await login(agent, "viewer@example.test", "acceptance-password");
  await expect(screen.getByRole("heading", { name: "录音库" })).toBeVisible();
  await expect(screen.getByRole("navigation", { name: "服务器管理" })).toHaveCount(0);
  expect((await api(browser, "/admin/overview")).status).toBe(403);
  expect((await api(browser, `/transcriptions/${tid}/insights`)).status).toBe(404);
  await browser.goto(base + "/admin/logs");
  await expect(screen.getByRole("heading", { name: "录音库" })).toBeVisible();
});

// @use-case docs/feature/administration/use-case/inspect-instance.md
test("管理概览、审计筛选与日志分页", async ({ agent, browser, screen }) => {
  await browser.goto(fixture("VOICES_TEST_URL") + "/recordings");
  await login(agent, "tester@example.test", "acceptance-password");
  await agent.act("进入站点概览页面。");
  await expect(screen.getByRole("heading", { name: "站点概览", exact: true })).toBeVisible();
  await expect(screen.getByText(/数据库可查询 ·/)).toBeVisible();
  await agent.act("进入账号管理页面。");
  await agent.act("关闭开放注册开关。");
  await agent.act("进入系统日志页面。");
  await expect(screen.getByRole("heading", { name: "系统日志", exact: true })).toBeVisible();
  await agent.act("按修改注册开关事件类型筛选日志。");
  await expect(
    browser.locator("[data-slot=card-title]").filter({ hasText: "修改注册开关" }),
  ).toBeVisible();
  await agent.act("将事件类型改为全部，再筛选日志。");
  await expect(screen.getByRole("button", { name: "下一页" })).toBeEnabled();
  await agent.act("查看日志下一页。");
  await expect(screen.getByRole("button", { name: "上一页" })).toBeEnabled();
  await agent.act(
    "切换运行异常，将请求 ID 填为 not-a-uuid 并筛选日志；预期格式错误，保留错误现场。",
  );
  await expect(screen.getByText("ID 格式不正确", { exact: false })).toBeVisible();
  await agent.act("清空请求 ID，再筛选日志。");
  await expect(screen.getByText("没有匹配的日志", { exact: false })).toBeVisible();
});

// @use-case docs/feature/administration/use-case/inspect-instance.md
test("账号关键词、角色与状态筛选以及停用", async ({ agent, browser, screen }) => {
  await browser.goto(fixture("VOICES_TEST_URL"));
  await login(agent, "tester@example.test", "acceptance-password");
  await agent.act("进入账号管理，搜索 VIEWER，角色选普通用户，状态选已启用，然后筛选账号。");
  await expect(screen.getByText("viewer@example.test", { exact: true })).toBeVisible();
  await expect(screen.getByRole("button", { name: "停用账号", exact: true })).toHaveCount(1);
  await agent.act("停用筛选出的 viewer 账号。");
  await expect(screen.getByText("没有匹配的账号", { exact: true })).toBeVisible();
  await agent.act("把账号状态改为已停用，再筛选账号。");
  await expect(screen.getByText("viewer@example.test", { exact: true })).toBeVisible();
  await expect(screen.getByRole("button", { name: "启用账号", exact: true })).toHaveCount(1);
  await agent.act("清空搜索账号，角色改为管理员，状态改为全部状态，再筛选账号。");
  await expect(screen.getByText("viewer@example.test", { exact: true })).toHaveCount(0);
  await expect(screen.getByRole("button", { name: "设为普通用户", exact: true })).toHaveCount(1);
});
