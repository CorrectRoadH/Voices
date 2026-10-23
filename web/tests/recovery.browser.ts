import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { api, fixture, noOverflow } from "./support/session";

// @use-case docs/feature/transcription/use-case/transcribe.md
test("任务原因、安全重试与确认风险后重新转写", async ({ app, browser, screen }) => {
  const id = fixture("VOICES_TEST_RECORDING");
  const job = fixture("VOICES_TEST_JOB");
  const base = fixture("VOICES_TEST_URL");
  await app.open();
  await screen.getByLabel("用户名或邮箱").fill("tester@example.test");
  await screen.getByLabel("密码", { exact: true }).fill("acceptance-password");
  await screen.getByRole("button", { name: "进入工作台" }).click();
  await expect(screen.getByRole("button", { name: "导入录音" }).first()).toBeVisible();
  await browser.goto(`${base}/admin/overview`);
  await expect(
    browser.locator("dl > div").filter({ hasText: "失败" }).getByText("2", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByText("状态待核对", { exact: true })).toHaveCount(0);
  for (const [key, label] of [
    ["UPLOADING", "上传服务商"],
    ["SUBMITTING", "提交转写"],
    ["POLLING", "等待服务商结果"],
    ["NORMALIZING", "整理结果"],
  ]) {
    await browser.goto(`${base}/recordings/${fixture(`VOICES_TEST_STAGE_${key}`)}`);
    await expect(screen.getByRole("status", { name: "正在转写" })).toBeVisible();
    await expect(screen.getByText(`当前阶段： ${label}`, { exact: true })).toBeVisible();
    await expect(screen.getByText("暂无转写", { exact: true })).toHaveCount(0);
    await expect(screen.getByRole("button", { name: "查看任务", exact: true })).toBeVisible();
  }
  await browser.goto(`${base}/jobs?recording_id=${id}`);
  await expect(screen.getByText("服务商返回了异常 HTTP 状态。 (HTTP 503)")).toBeVisible();
  await expect(screen.getByText("结果待确认", { exact: true })).toHaveCount(0);
  await expect(screen.getByRole("button", { name: "登记核对结果", exact: true })).toHaveCount(0);
  await screen.getByLabel("任务状态", { exact: true }).selectOption({ value: "failed" });
  const recordingLink = screen.getByRole("link", { name: "待确认恢复验收", exact: true });
  await expect(recordingLink).toHaveCount(1);
  await expect(recordingLink).toHaveAttribute("href", `/recordings/${id}`);
  await expect(screen.getByText("失败", { exact: true }).last()).toBeVisible();
  await recordingLink.click();
  await expect(screen.getByRole("heading", { name: "待确认恢复验收", exact: true })).toBeVisible();
  await browser.goto(`${base}/jobs?recording_id=${id}&state=failed`);
  await expect(screen.getByText(`任务 ID：${job}`, { exact: true })).not.toBeVisible();
  await screen.getByText("任务详情", { exact: true }).click();
  await expect(screen.getByText(`任务 ID：${job}`, { exact: true })).toBeVisible();
  await screen.getByText("任务详情", { exact: true }).click();
  await expect(screen.getByRole("button", { name: "重试", exact: true })).toHaveCount(0);
  await app.screenshot("任务显示具体原因与重新转写入口");
  await screen.getByRole("button", { name: "重新转写", exact: true }).click();
  await expect(screen.getByRole("dialog")).toBeVisible();
  await expect(screen.getByRole("button", { name: "开始转写", exact: true })).toBeEnabled();
  await browser.keyboard.press("Escape");
  await expect(screen.getByRole("dialog")).toHaveCount(0);
  let versions = await (await api(browser, `/recordings/${id}/transcriptions`)).json();
  expect(versions.items.length, "取消不能创建新版本").toBe(1);
  await expect(screen.getByText("音频已就绪", { exact: true }).first()).toBeVisible();
  await screen.getByRole("button", { name: "重新转写", exact: true }).click();
  await expect(screen.getByRole("switch", { name: "我接受可能重复收费，另建新版本" })).toHaveCount(
    0,
  );
  await screen.getByRole("button", { name: "开始转写", exact: true }).click();
  await expect(screen.getByRole("dialog")).toHaveCount(0);
  await expect(screen.getByRole("status", { name: "转写排队中" })).toBeVisible();
  await expect(screen.getByText("暂无转写", { exact: true })).toHaveCount(0);
  versions = await (await api(browser, `/recordings/${id}/transcriptions`)).json();
  expect(versions.items.length).toBe(2);
  const jobs = await (await api(browser, `/jobs?recording_id=${id}`)).json();
  expect(jobs.items.find((item: { id: string }) => item.id === job).state).toBe("uncertain");
  await browser.goto(`${base}/jobs?recording_id=${fixture("VOICES_TEST_FAILED_RECORDING")}`);
  await expect(screen.getByText("服务商返回了异常 HTTP 状态。 (HTTP 401)")).toBeVisible();
  await screen.getByRole("button", { name: "重试", exact: true }).click();
  await expect(screen.getByText("服务商返回了异常 HTTP 状态。 (HTTP 401)")).toHaveCount(0);
  await browser.goto(`${base}/recordings/${fixture("VOICES_TEST_FAILED_RECORDING")}`);
  await expect(screen.getByRole("status", { name: "转写排队中" })).toBeVisible();
  await noOverflow(browser);
  await app.screenshot("明确失败任务安全重试");
  await browser.goto(`${base}/admin/server`);
  await expect(screen.getByLabel("LLM Base URL", { exact: true })).toBeVisible();
  await app.screenshot("精简后的服务器设置");
});
