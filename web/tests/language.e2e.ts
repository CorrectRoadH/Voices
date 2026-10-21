import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { api, fixture, login, logout } from "./support/session";

// @use-case docs/feature/interface-language/use-case/choose-language.md
test("访客和账号语言隔离、失败回滚、保留中文内容与移动端布局", async ({ app, browser, screen }) => {
  const base = fixture("VOICES_TEST_URL");
  const password = "test-language-password";
  await browser.emulateMedia({ colorScheme: "dark" });
  await browser.goto(base);
  await expect(browser).toHaveTitle("Voices");
  await screen.getByLabel("界面语言", { exact: true }).selectOption({ value: "en" });
  await expect(screen.getByText("Create administrator account", { exact: true })).toBeVisible();
  await expect(browser.locator("html")).toHaveAttribute("lang", "en");
  await browser.reload();
  await expect(screen.getByLabel("Interface language", { exact: true })).toHaveValue("en");
  await screen.getByLabel("Email", { exact: true }).fill("language-admin@example.test");
  await screen.getByLabel("Username", { exact: true }).fill("language_admin");
  await screen.getByLabel("Password", { exact: true }).fill(password);
  await screen.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(screen.getByRole("heading", { name: "Set up your site" })).toBeVisible();
  await screen.getByRole("button", { name: "Continue without LLM", exact: true }).click();
  // 注册时选择的语言写入新账号。
  await expect(browser.locator("html")).toHaveAttribute("lang", "en");
  await screen.getByRole("link", { name: "My account", exact: true }).click();
  await screen.getByLabel("Interface language", { exact: true }).selectOption({ value: "zh-CN" });
  await expect(browser.locator("html")).toHaveAttribute("lang", "zh-CN");
  await screen.getByRole("link", { name: "我的账号", exact: true }).click();
  await screen.getByLabel("显示名称", { exact: true }).fill("中文用户名");
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
  await screen.getByLabel("界面语言", { exact: true }).selectOption({ value: "en" });
  await expect(screen.getByRole("heading", { name: "My account", exact: true })).toBeVisible();
  await expect(screen.getByText("Interface language saved", { exact: true })).toBeVisible();
  expect(
    await browser.evaluate(
      () => (window as unknown as { draftNode: Element }).draftNode.isConnected,
    ),
  ).toBe(true);
  await expect(screen.getByLabel("Display name", { exact: true })).toHaveValue("中文用户名");
  await screen.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(
    browser.locator("[data-slot=toast-description]").filter({ hasText: "Profile saved" }),
  ).toBeVisible();
  await browser.locator("[data-slot=toast-close]").click();
  await browser.reload();
  await expect(screen.getByLabel("Interface language", { exact: true })).toHaveValue("en");

  // 保留中文用户内容，仅翻译内置标签。
  const person = await api(browser, "/people", "POST", { display_name: "音乐", notes: "中文备注" });
  expect(person.status).toBe(201);
  await screen.getByRole("link", { name: "People", exact: true }).click();
  await expect(screen.getByText("音乐", { exact: true })).toBeVisible();
  await expect(screen.getByText("中文备注", { exact: true })).toBeVisible();
  await screen.getByRole("link", { name: "Transcription preferences", exact: true }).click();
  await expect(screen.getByText("Provider connections", { exact: true })).toBeVisible();
  await expect(screen.getByLabel("Language mode", { exact: true })).toBeVisible();
  await screen.getByRole("link", { name: "Jobs", exact: true }).click();
  await expect(screen.getByText("No jobs yet", { exact: true })).toBeVisible();
  for (const name of ["Overview", "System logs", "Account management", "Server settings"]) {
    await screen.getByRole("link", { name, exact: true }).click();
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
  await screen.getByRole("button", { name: "Retry autosave", exact: true }).click();
  await expect(screen.getByTestId("settings-save-status")).toHaveText("All changes saved");
  await screen.getByLabel("LLM Base URL", { exact: true }).fill(fixture("VOICES_MODEL_TEST_URL"));
  await expect(screen.getByTestId("settings-save-status")).toHaveText("All changes saved");
  await screen.getByRole("button", { name: "Fetch LLM models", exact: true }).click();
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
  await expect(screen.getByText("No transcript yet", { exact: true })).toBeVisible();
  await expect(screen.getByText("Complete a transcription to generate an outline.")).toBeVisible();
  await browser.setViewport({ width: 390, height: 844 });
  await app.screenshot("英文手机界面");
  expect(await browser.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await screen.getByRole("link", { name: "My account", exact: true }).click();
  expect(await browser.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await app.screenshot("英文手机界面");
  // 退出恢复访客偏好，新账号不继承上一账号语言。
  await screen.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(screen.getByLabel("Interface language", { exact: true })).toHaveValue("en");
  await screen.getByRole("button", { name: "Need an account? Register", exact: true }).click();
  await screen.getByLabel("Email", { exact: true }).fill("language-other@example.test");
  await screen.getByLabel("Username", { exact: true }).fill("language_other");
  await screen.getByLabel("Password", { exact: true }).fill(password);
  await screen.getByLabel("Interface language", { exact: true }).selectOption({ value: "zh-CN" });
  await screen.getByRole("button", { name: "创建账号", exact: true }).click();
  await expect(browser.locator("html")).toHaveAttribute("lang", "zh-CN");
  await screen.getByRole("link", { name: "我的账号", exact: true }).click();
  await expect(screen.getByLabel("界面语言", { exact: true })).toHaveValue("zh-CN");

  // 清空访客缓存后登录，仍使用服务端保存的账号语言。
  await logout(browser);
  await browser.evaluate(() => {
    localStorage.clear();
    return null;
  });
  await browser.reload();
  await expect(screen.getByLabel("界面语言")).toHaveValue("zh-CN");
  await login(screen, "language_admin", password);
  await expect(browser.locator("html")).toHaveAttribute("lang", "en");
  await expect(screen.getByRole("link", { name: "People" })).toBeVisible();
});
