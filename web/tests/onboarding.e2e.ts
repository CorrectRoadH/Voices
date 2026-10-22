import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { api, fixture, login, logout, noOverflow, register } from "./support/session";

// @use-case docs/feature/accounts/use-case/setup-site.md
test(
  "管理员注册后独立初始化、恢复草稿、测试失败修正和普通用户分流",
  { timeout: 300000 },
  async ({ app, agent, browser, screen }) => {
    await browser.emulateMedia({ colorScheme: "dark" });
    await app.open();
    await agent.act(
      "用邮箱 setup@example.test、用户名 SetupAdmin、密码 123456 创建管理员账号，停在初始化站点页面，不填写配置。",
    );
    await expect(screen.getByRole("heading", { name: "初始化站点", exact: true })).toBeVisible();
    await expect(screen.getByRole("link", { name: "账号管理", exact: true })).toHaveCount(0);
    await expect(
      screen.getByRole("button", { name: "完成站点初始化", exact: true }),
    ).toBeDisabled();
    const auth = await (await api(browser, "/auth/status")).json();
    expect(auth.initialized).toBe(true);
    expect(auth.site_setup_completed).toBe(false);
    expect(auth.registration_open).toBe(false);
    await agent.act(
      "填写 LLM Base URL 为 {url}、LLM API Key 为 browser-private-key、模型名称为 invalid-model，等待自动保存，不测试连接。",
      { params: { url: fixture("VOICES_MODEL_TEST_URL") } },
    );
    await expect(screen.getByTestId("settings-save-status")).toHaveText("所有修改已保存");
    await browser.reload();
    await expect(screen.getByLabel("模型名称", { exact: true })).toHaveValue("invalid-model");
    await expect(screen.getByRole("button", { name: "清除 LLM 密钥", exact: true })).toBeVisible();
    await logout(agent);
    await login(agent, "SetupAdmin", "123456");
    await expect(screen.getByRole("heading", { name: "初始化站点", exact: true })).toBeVisible();
    await agent.act("测试 LLM 连接一次；无论成功还是失败都停止，不重试、不修改配置。");
    await expect(screen.getByText(/LLM 测试失败/).first()).toBeVisible();
    await expect(
      screen.getByRole("button", { name: "完成站点初始化", exact: true }),
    ).toBeDisabled();
    await browser.locator("[data-slot=toast-close]").click();
    await agent.act("获取 LLM 模型列表一次，暂不选择模型。");
    await expect(screen.getByRole("status").filter({ hasText: "已获取 1 个模型" })).toBeVisible();
    await agent.act("从模型候选列表选择 sample-model，等待自动保存。");
    await expect(screen.getByTestId("settings-save-status")).toHaveText("所有修改已保存");
    await agent.act("测试 LLM 连接一次；无论成功还是失败都停止，不重试、不修改配置。");
    await expect(screen.getByText("当前配置测试通过", { exact: true })).toBeVisible();
    await browser.reload();
    await expect(screen.getByText("当前配置测试通过", { exact: true })).toBeVisible();
    await app.screenshot("站点初始化桌面");
    await browser.setViewport({ width: 390, height: 844 });
    await noOverflow(browser);
    await app.screenshot("站点初始化手机");
    await agent.act("完成站点初始化，进入录音库。");
    await expect(screen.getByRole("heading", { name: "录音库", exact: true })).toBeVisible();
    await logout(agent);
    await agent.act("切换到注册页面。");
    await register(agent, "normal@example.test", "NormalUser", "123456");
    await expect(screen.getByRole("heading", { name: "初始化站点", exact: true })).toHaveCount(0);
    expect((await api(browser, "/admin/onboarding")).status).toBe(403);
  },
);

// @use-case docs/feature/accounts/use-case/setup-site.md
test(
  "配置修改使测试失效，旧测试结果不能批准新配置",
  { timeout: 300000 },
  async ({ app, agent, browser, screen }) => {
    await app.open();
    await agent.act(
      "用邮箱 revision@example.test、用户名 RevisionAdmin、密码 123456 创建管理员账号，停在初始化站点页面，不填写配置。",
    );
    await expect(screen.getByRole("heading", { name: "初始化站点", exact: true })).toBeVisible();
    await agent.act(
      "将 LLM Base URL 填为 {url}，模型名称填为 sample-model，等待自动保存。不要测试或完成初始化。",
      {
        params: { url: fixture("VOICES_MODEL_TEST_URL") },
      },
    );
    await expect(screen.getByTestId("settings-save-status")).toHaveText("所有修改已保存");
    await agent.act("测试当前 LLM 连接，停留在初始化页。");
    await expect(screen.getByText("当前配置测试通过", { exact: true })).toBeVisible();
    const complete = screen.getByRole("button", { name: "完成站点初始化", exact: true });
    await expect(complete).toBeEnabled();

    await agent.act("将模型名称改成 delayed-model，等待自动保存，不测试连接。");
    await expect(screen.getByTestId("settings-save-status")).toHaveText("所有修改已保存");
    await expect(screen.getByText("当前配置尚未通过测试", { exact: true })).toBeVisible();
    await expect(complete).toBeDisabled();
    await browser.reload();
    await expect(complete).toBeDisabled();

    // 精确控制竞态：只阻塞外部 LLM，业务请求和修订校验仍经过真实 Go/PG。
    await screen.getByRole("button", { name: "测试 LLM 连接", exact: true }).click();
    const remote = fixture("VOICES_MODEL_TEST_URL");
    try {
      await expect
        .poll(async () => (await (await fetch(`${remote}/test/status`)).json()).waiting)
        .toBe(true);
      const state = await (await api(browser, "/admin/server-settings")).json();
      expect(
        (
          await api(browser, "/admin/server-settings", "PATCH", {
            revision: state.revision,
            llm_model: "replacement-model",
          })
        ).status,
      ).toBe(200);
    } finally {
      await fetch(`${remote}/test/release`, { method: "POST" });
    }
    await expect(screen.getByRole("button", { name: "测试 LLM 连接", exact: true })).toBeEnabled();
    await expect(screen.getByText("当前配置尚未通过测试", { exact: true })).toBeVisible();
    await expect(complete).toBeDisabled();
    expect((await (await api(browser, "/admin/onboarding")).json()).llm_tested).toBe(false);
    await browser.reload();
    await expect(screen.getByLabel("模型名称", { exact: true })).toHaveValue("replacement-model");
    await expect(complete).toBeDisabled();
    await agent.act("测试当前 LLM 连接，停留在初始化页。");
    await expect(screen.getByText("当前配置测试通过", { exact: true })).toBeVisible();
    await expect(complete).toBeEnabled();
  },
);

// @use-case docs/feature/accounts/use-case/setup-site.md
test(
  "清空配置后跳过，完成失败可重试且完成后不再初始化",
  { timeout: 300000 },
  async ({ app, agent, browser, screen }) => {
    await app.open();
    await agent.act(
      "用邮箱 skip@example.test、用户名 SkipAdmin、密码 123456 创建管理员账号，停在初始化站点页面，不填写配置。",
    );
    await expect(screen.getByRole("heading", { name: "初始化站点", exact: true })).toBeVisible();
    await agent.act(
      "将 LLM Base URL 填为 {url}、模型名称填为 sample-model、LLM API Key 填为 test-only-key，等待自动保存。不要测试连接。",
      {
        params: { url: fixture("VOICES_MODEL_TEST_URL") },
      },
    );
    await expect(screen.getByTestId("settings-save-status")).toHaveText("所有修改已保存");
    const skip = screen.getByRole("button", { name: "暂不启用 LLM", exact: true });
    await expect(skip).toBeDisabled();
    await expect(screen.getByRole("button", { name: "清除 LLM 密钥", exact: true })).toBeVisible();
    await agent.act(
      "清除已保存的 LLM 密钥，再清空 LLM Base URL 和模型名称，等待自动保存。不要完成初始化或点击暂不启用 LLM。",
    );
    await expect(screen.getByTestId("settings-save-status")).toHaveText("所有修改已保存");
    await expect(skip).toBeEnabled();
    const saved = await (await api(browser, "/admin/server-settings")).json();
    expect(saved.saved.llm_base_url).toBe("");
    expect(saved.saved.llm_model).toBe("");
    expect(saved.saved.llm_configured).toBe(false);

    let attempts = 0;
    await browser.route("**/api/v1/admin/onboarding", async (route) => {
      if (route.request.method === "POST") {
        attempts++;
        await route.abort();
      } else await route.continue();
    });
    // 故障注入只点击一次，禁止模型自行重试掩盖失败状态。
    await skip.click();
    await expect(screen.getByText(/网络连接中断或请求超时/).first()).toBeVisible();
    await expect(skip).toBeEnabled();
    expect(attempts).toBe(1);
    expect((await (await api(browser, "/auth/status")).json()).site_setup_completed).toBe(false);
    await browser.unroute("**/api/v1/admin/onboarding");
    await agent.act("选择暂不启用 LLM，完成初始化并进入录音库。");
    await expect(screen.getByRole("heading", { name: "录音库", exact: true })).toBeVisible();
    expect((await (await api(browser, "/auth/status")).json()).site_setup_completed).toBe(true);
    await browser.goto(fixture("VOICES_TEST_URL") + "/onboarding");
    await expect(browser).toHaveURL(fixture("VOICES_TEST_URL") + "/recordings");
    await expect(screen.getByRole("heading", { name: "初始化站点", exact: true })).toHaveCount(0);
  },
);
