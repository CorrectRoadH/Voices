import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { api, fixture, login, logout } from "./support/session";

// @use-case docs/feature/interface-language/use-case/choose-language.md
test("访客和账号语言隔离、失败回滚、保留中文内容与移动端布局", async ({
  app,
  agent,
  browser,
  screen,
}) => {
  const base = fixture("VOICES_TEST_URL");
  const password = "test-language-password";
  await browser.emulateMedia({ colorScheme: "dark" });
  await browser.goto(base);
  await expect(browser).toHaveTitle("Voices");
  await agent.act("把界面语言切换为 English。");
  await expect(screen.getByText("Create administrator account", { exact: true })).toBeVisible();
  await expect(browser.locator("html")).toHaveAttribute("lang", "en");
  await browser.reload();
  await expect(screen.getByLabel("Interface language", { exact: true })).toHaveValue("en");
  await agent.act(
    "保持英文界面，用邮箱 language-admin@example.test、用户名 language_admin、密码 test-language-password 创建管理员账号，停在初始化页面。",
  );
  await expect(screen.getByRole("heading", { name: "Set up your site" })).toBeVisible();
  await agent.act("选择 Continue without LLM 完成初始化。");
  // 注册时选择的语言写入新账号。
  await expect(browser.locator("html")).toHaveAttribute("lang", "en");
  await agent.act("进入 My account，把界面语言切换为简体中文。");
  await expect(browser.locator("html")).toHaveAttribute("lang", "zh-CN");
  await agent.act("在我的账号中把显示名称填写为中文用户名，先不要保存资料。");
  await browser.route("**/api/v1/me", async (route) => {
    if (route.request.method === "PATCH" && JSON.parse(route.request.postData || "{}").ui_language)
      await route.abort();
    else await route.continue();
  });
  await screen.getByLabel("界面语言", { exact: true }).selectOption({ value: "en" });
  await expect(
    browser.locator("[data-slot=toast-description]").filter({ hasText: "网络连接中断或请求超时" }),
  ).toBeVisible();
  await expect(browser.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(screen.getByLabel("界面语言", { exact: true })).toHaveValue("zh-CN");
  await browser.locator("[data-slot=toast-close]").click();
  await expect(
    browser.locator("[data-slot=toast-description]").filter({ hasText: "网络连接中断或请求超时" }),
  ).toHaveCount(0);
  await browser.unroute("**/api/v1/me");
  // 切换语言后保留同一个草稿输入节点。
  await browser.evaluate(() => {
    (window as unknown as { draftNode: Element | null }).draftNode = document.querySelector(
      'input[value="中文用户名"]',
    );
    return null;
  });
  await agent.act("把界面语言切换为 English。");
  await expect(screen.getByRole("heading", { name: "My account", exact: true })).toBeVisible();
  await expect(screen.getByText("Interface language saved", { exact: true })).toBeVisible();
  expect(
    await browser.evaluate(
      () => (window as unknown as { draftNode: Element }).draftNode.isConnected,
    ),
  ).toBe(true);
  await expect(screen.getByLabel("Display name", { exact: true })).toHaveValue("中文用户名");
  // Observe the 4.5-second toast immediately; model round-trips can outlast it.
  await screen.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(
    browser.locator("[data-slot=toast-description]").filter({ hasText: "Profile saved" }),
  ).toBeVisible();
  await browser.locator("[data-slot=toast-close]").click();
  await browser.reload();
  await expect(screen.getByLabel("Interface language", { exact: true })).toHaveValue("en");
  await expect(screen.getByLabel("Display name", { exact: true })).toHaveValue("中文用户名");

  // 保留中文用户内容，仅翻译内置标签。
  const person = await api(browser, "/people", "POST", { display_name: "音乐", notes: "中文备注" });
  expect(person.status).toBe(201);
  await agent.act("打开 People 页面。");
  await expect(screen.getByText("音乐", { exact: true })).toBeVisible();
  await expect(screen.getByText("中文备注", { exact: true })).toBeVisible();
  await agent.act("打开 Transcription preferences 页面。");
  await expect(screen.getByText("Provider connections", { exact: true })).toBeVisible();
  await expect(screen.getByLabel("Language mode", { exact: true })).toBeVisible();
  await agent.act("打开 Jobs 页面。");
  await expect(screen.getByText("No jobs yet", { exact: true })).toBeVisible();
  for (const name of ["Overview", "System logs", "Account management", "Server settings"]) {
    await agent.act("打开 {name} 页面。", { params: { name } });
    await expect(screen.getByRole("heading", { name, exact: true })).toBeVisible();
    const visible = await browser.locator("main").textContent();
    expect((visible || "").replaceAll("中文用户名", "").replaceAll("简体中文", "")).not.toMatch(
      /[\u3400-\u9fff]/,
    );
  }
  await browser.route("**/api/v1/admin/server-settings", async (route) => {
    if (route.request.method === "PATCH") await route.abort();
    else await route.continue();
  });
  await screen.getByLabel("Model name", { exact: true }).fill("local-model");
  await expect(screen.getByTestId("settings-save-status")).toHaveText(
    "Autosave failed; changes are not saved",
  );
  await expect(
    browser
      .locator("[data-slot=toast-description]")
      .filter({ hasText: "The connection was interrupted" }),
  ).toBeVisible();
  await browser.locator("[data-slot=toast-close]").click();
  await browser.unroute("**/api/v1/admin/server-settings");
  await agent.act("重试自动保存当前服务器配置。");
  await expect(screen.getByTestId("settings-save-status")).toHaveText("All changes saved");
  await agent.act("将 LLM Base URL 改为 {url} 并等待自动保存，不获取模型。", {
    params: { url: fixture("VOICES_MODEL_TEST_URL") },
  });
  await expect(screen.getByTestId("settings-save-status")).toHaveText("All changes saved");
  await agent.act("获取 LLM 模型一次；出现服务拒绝访问提示后立即停止，不重试。");
  await expect(
    browser
      .locator("[data-slot=toast-description]")
      .filter({ hasText: "The model service denied access" }),
  ).toBeVisible();
  await expect(screen.getByText("private upstream response", { exact: true })).toHaveCount(0);
  await browser.locator("[data-slot=toast-close]").click();
  // 真实上传验证英文详情页，不调用付费转写。
  const wav = Buffer.alloc(44 + 32000);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(32000, 40);
  const form = new FormData();
  form.append("metadata", JSON.stringify({ title: "中文会议", auto_transcribe: false }));
  form.append("file", new Blob([wav], { type: "audio/wav" }), "meeting.wav");
  const uploaded = await api(browser, "/recordings", "POST", form);
  expect(uploaded.status).toBe(201);
  const recording = (await uploaded.json()).recording;
  await browser.goto(`${base}/recordings/${recording.id}`);
  await expect(screen.getByRole("heading", { name: "中文会议", exact: true })).toBeVisible();
  await expect(
    screen.getByRole("tab", { name: "Recording information", exact: true }),
  ).toBeVisible();
  // 此 fixture 未启动准备 worker，上传后应明确展示准备状态。
  await expect(screen.getByText("Preparing audio", { exact: true })).toBeVisible();
  await expect(screen.getByText("Complete a transcription to generate an outline.")).toBeVisible();
  await browser.setViewport({ width: 390, height: 844 });
  await app.screenshot("英文手机界面");
  expect(await browser.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await agent.act("打开 My account 页面。");
  expect(await browser.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await app.screenshot("英文手机界面");
  // 退出恢复访客偏好，新账号不继承上一账号语言。
  await logout(agent);
  await expect(screen.getByLabel("Interface language", { exact: true })).toHaveValue("en");
  await agent.act(
    "切换到注册页面，选择简体中文，用邮箱 language-other@example.test、用户名 language_other、密码 test-language-password 创建普通账号。",
  );
  await expect(browser.locator("html")).toHaveAttribute("lang", "zh-CN");
  await agent.act("打开我的账号页面。");
  await expect(screen.getByLabel("界面语言", { exact: true })).toHaveValue("zh-CN");

  // 清空访客缓存后登录，仍使用服务端保存的账号语言。
  await logout(agent);
  await browser.evaluate(() => {
    localStorage.clear();
    return null;
  });
  await browser.reload();
  await expect(screen.getByLabel("界面语言")).toHaveValue("zh-CN");
  await login(agent, "language_admin", password);
  await expect(browser.locator("html")).toHaveAttribute("lang", "en");
  await expect(screen.getByRole("link", { name: "People" })).toBeVisible();
});
