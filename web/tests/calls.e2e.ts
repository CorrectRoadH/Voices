import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { fixture, login, noOverflow } from "./support/session";

// @use-case docs/feature/call-logs/use-case/inspect-calls.md
test("个人与管理调用日志共用筛选、详情和分页", async ({ app, agent, browser, screen }) => {
  const base = fixture("VOICES_TEST_URL");
  await browser.goto(base + "/recordings");
  await login(agent, "tester@example.test", "acceptance-password");
  await agent.act("进入处理任务页面，再切换到调用日志标签。");
  await expect(
    screen.getByText("查看自己的 STT 与 AI 调用，调用记录永久保存。", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByText("输入 / 输出 / 总 token: 25 / 7 / 32", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByText("HTTP: 401", { exact: true })).toHaveCount(0);
  await agent.act("展开这条生成摘要与章节记录的调用详情，然后点击刷新。");
  await expect(browser.locator('[data-slot="badge"]').first()).toHaveText("调用成功");
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
  await agent.act("展开第一条上传音频记录的调用详情，查看错误原因。");
  await expect(screen.getByText("错误代码：auth · http_status", { exact: true })).toHaveCount(51);
  await browser.setViewport({ width: 390, height: 844 });
  await noOverflow(browser);
  await app.screenshot("手机调用日志");
  await agent.act("将模型 ID 筛选为 nonexistent-model。");
  await expect(screen.getByText("暂无调用记录", { exact: true })).toBeVisible();
});
