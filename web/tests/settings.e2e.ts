import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { api, fixture, logout, register } from "./support/session";

// @use-case docs/feature/accounts/use-case/manage-server.md
test("服务器配置自动保存、密钥清除、失败重试与并发冲突", async ({ app, browser, screen }) => {
  const base = fixture("VOICES_TEST_URL");
  await browser.goto(base);
  await expect(browser).toHaveTitle("Voices");
  await screen.getByLabel("邮箱", { exact: true }).fill("server-admin@example.test");
  await screen.getByLabel("用户名", { exact: true }).fill("ServerAdmin");
  await screen.getByLabel("密码", { exact: true }).fill("test-browser-password");
  await screen.getByRole("button", { name: "创建账号", exact: true }).click();
  await screen.getByRole("button", { name: "暂不启用 LLM", exact: true }).click();
  await screen.getByRole("link", { name: "服务器设置", exact: true }).click();
  await expect(screen.getByRole("heading", { name: "服务器设置", exact: true })).toBeVisible();
  await expect(screen.getByLabel("站点 Base URL")).toHaveValue(base);
  await expect(screen.getByRole("button", { name: "保存服务器配置", exact: true })).toHaveCount(0);
  await expect(screen.getByRole("button", { name: "重新加载已保存配置", exact: true })).toHaveCount(
    0,
  );
  await screen.getByLabel("Soniox API Key", { exact: true }).fill("browser-soniox-key");
  await screen.getByLabel("AssemblyAI API Key", { exact: true }).fill("browser-assembly-key");
  await screen.getByLabel("LLM Base URL", { exact: true }).fill("https://llm.example/v1");
  await screen.getByLabel("模型名称", { exact: true }).fill("browser-model");
  await screen.getByLabel("LLM API Key", { exact: true }).fill("browser-llm-key");
  await expect(screen.getByTestId("settings-save-status")).toHaveText("所有修改已保存");
  await expect(screen.getByText("已保存，等待重启生效", { exact: true })).toBeVisible();
  await expect(screen.getByRole("button", { name: "清除 Soniox 密钥" })).toBeVisible();
  await expect(screen.getByRole("button", { name: "清除 LLM 密钥" })).toBeVisible();
  await browser.reload();
  await expect(screen.getByLabel("模型名称")).toHaveValue("browser-model");
  // 修改普通字段时保留已保存的密钥。
  await screen.getByLabel("模型名称", { exact: true }).fill("browser-model-updated");
  await expect(screen.getByTestId("settings-save-status")).toHaveText("所有修改已保存");
  await expect(screen.getByRole("button", { name: "清除 LLM 密钥", exact: true })).toBeVisible();
  await screen.getByLabel("模型名称", { exact: true }).fill("browser-model");
  await expect(screen.getByTestId("settings-save-status")).toHaveText("所有修改已保存");
  // 清除密钥可在保存前取消。
  await screen.getByRole("button", { name: "清除 Soniox 密钥", exact: true }).click();
  await expect(screen.getByLabel("Soniox API Key", { exact: true })).toBeDisabled();
  await screen.getByRole("button", { name: "取消清除 Soniox 密钥", exact: true }).click();
  await expect(screen.getByLabel("Soniox API Key", { exact: true })).toBeEnabled();
  await screen.getByRole("button", { name: "清除 Soniox 密钥", exact: true }).click();
  await expect(screen.getByTestId("settings-save-status")).toHaveText("所有修改已保存");
  await expect(screen.getByRole("button", { name: "清除 Soniox 密钥", exact: true })).toHaveCount(
    0,
  );
  // 延迟真实响应，期间的编辑须按下一 revision 排队保存。
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent = new Promise<void>((resolve) => {
    started = resolve;
  });
  await browser.route("**/api/v1/admin/server-settings", async (route) => {
    if (
      route.request.method === "PATCH" &&
      JSON.parse(route.request.postData || "{}").llm_model === "slow-model"
    ) {
      const response = await fetch(route.request.url, {
        method: route.request.method,
        headers: route.request.headers,
        body: route.request.postData,
        signal: AbortSignal.timeout(10000),
      });
      const body = await response.text();
      started();
      await gate;
      await route.fulfill({ status: response.status, contentType: "application/json", body });
    } else await route.continue();
  });
  await screen.getByLabel("模型名称", { exact: true }).fill("slow-model");
  await sent;
  await expect(screen.getByTestId("settings-save-status")).toHaveText("正在自动保存…");
  await screen.getByLabel("模型名称", { exact: true }).fill("browser-model");
  await screen.getByLabel("LLM API Key", { exact: true }).fill("browser-llm-key");
  release();
  await expect(screen.getByTestId("settings-save-status")).toHaveText("所有修改已保存");
  await expect(screen.getByLabel("模型名称", { exact: true })).toHaveValue("browser-model");
  await expect(screen.getByRole("button", { name: "清除 LLM 密钥" })).toBeVisible();
  await browser.unroute("**/api/v1/admin/server-settings");
  // 网络失败保留草稿，仅显式重试重新发送。
  let failures = 0;
  await browser.route("**/api/v1/admin/server-settings", async (route) => {
    if (route.request.method === "PATCH") {
      failures++;
      await route.abort();
    } else await route.continue();
  });
  await screen.getByLabel("模型名称", { exact: true }).fill("retry-model");
  await expect(screen.getByTestId("settings-save-status")).toHaveText("自动保存失败，修改尚未保存");
  await expect(
    browser.locator("[data-slot=toast-description]").filter({ hasText: "网络连接中断或请求超时" }),
  ).toBeVisible();
  await browser.locator("[data-slot=toast-close]").click();
  await new Promise<void>((resolve) => setTimeout(resolve, 1100));
  expect(failures).toBe(1);
  await expect(screen.getByLabel("模型名称", { exact: true })).toHaveValue("retry-model");
  await browser.unroute("**/api/v1/admin/server-settings");
  await screen.getByRole("button", { name: "重试自动保存", exact: true }).click();
  await expect(screen.getByTestId("settings-save-status")).toHaveText("所有修改已保存");
  // 并发更新产生冲突，保留本地草稿。
  const snapshot = await (await api(browser, "/admin/server-settings")).json();
  const external = await api(browser, "/admin/server-settings", "PATCH", {
    revision: snapshot.revision,
    llm_model: "browser-model",
  });
  expect(external.status, "并发修改应落库").toBe(200);
  await screen.getByLabel("模型名称", { exact: true }).fill("conflicting-draft");
  await expect(
    browser.locator("[data-slot=alert]").filter({ hasText: "配置已被其它页面修改" }),
  ).toBeVisible();
  await expect(
    browser.locator("[data-slot=toast-description]").filter({ hasText: "配置已被其它页面修改" }),
  ).toBeVisible();
  await expect(screen.getByLabel("模型名称", { exact: true })).toHaveValue("conflicting-draft");
  await browser.reload();
  await expect(screen.getByLabel("模型名称", { exact: true })).toHaveValue("browser-model");
  await app.screenshot("服务器配置");
  await browser.setViewport({ width: 390, height: 844 });
  await expect(screen.getByLabel("站点 Base URL")).toBeVisible();
  expect(await browser.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );

  // 普通用户不能进入服务器设置，也不能通过 API 读取。
  await logout(browser);
  await screen.getByRole("button", { name: "没有账号？注册" }).click();
  await register(screen, "server-user@example.test", "ServerUser", "test-browser-password");
  await expect(screen.getByRole("link", { name: "服务器设置" })).toHaveCount(0);
  expect((await api(browser, "/admin/server-settings")).status).toBe(403);
  await browser.goto(base + "/admin/server");
  await expect(screen.getByRole("heading", { name: "录音库" })).toBeVisible();
});
