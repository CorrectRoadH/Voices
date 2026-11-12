import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { writeFile } from "node:fs/promises";
import { api, fixture, noOverflow } from "./support/session";

// @feature docs/feature/interface-interactions/ui.md
test("加载阶段、行内编辑快捷键、保存状态与真实并发冲突", async ({ app, browser, screen }) => {
  const id = fixture("VOICES_TEST_RECORDING");
  await app.open();
  await expect(screen.getByRole("button", { name: "进入工作台" })).toBeVisible();
  expect(
    await browser.evaluate(() => {
      const card = document.querySelector('[data-slot="card"]')!.getBoundingClientRect();
      return Math.abs(card.left + card.width / 2 - innerWidth / 2) < 2;
    }),
  ).toBe(true);
  await app.screenshot("centered-official-login");
  await screen.getByLabel("用户名或邮箱").fill("tester@example.test");
  await screen.getByLabel("密码", { exact: true }).fill("acceptance-password");
  await screen.getByRole("button", { name: "进入工作台" }).click();
  await expect(screen.getByRole("button", { name: "导入录音" }).first()).toBeVisible();
  await browser.emulateMedia({ reducedMotion: "reduce" });
  await noOverflow(browser);
  await expect(browser.locator('[data-slot="card"] .recording-row')).toHaveCount(0);
  await app.screenshot("desktop-library-shadcn");
  await screen.getByRole("button", { name: "我的账号", exact: true }).click();
  await expect(screen.getByRole("menuitem", { name: "退出登录", exact: true })).toBeVisible();
  await app.screenshot("official-account-menu");
  await browser.keyboard.press("Escape");
  await browser.setViewport({ width: 375, height: 812 });
  await screen.getByRole("button", { name: "切换导航", exact: true }).click();
  await expect(screen.getByRole("dialog")).toBeVisible();
  await app.screenshot("mobile-official-sidebar");
  await screen.getByRole("link", { name: "人物", exact: true }).click();
  await expect(screen.getByRole("dialog")).toHaveCount(0);
  await expect(screen.getByRole("heading", { name: "人物", exact: true })).toBeVisible();
  await noOverflow(browser);
  await browser.setViewport({ width: 1440, height: 1000 });

  await browser.goto(`${fixture("VOICES_TEST_URL")}/recordings/${id}`);
  await expect(screen.getByRole("status", { name: "正在准备音频" })).toBeVisible();
  await expect(screen.getByText("暂无转写", { exact: true })).toHaveCount(0);
  await expect(screen.getByRole("tab", { name: "摘要", exact: true })).toHaveCount(0);
  await expect(screen.getByRole("tab", { name: "目录", exact: true })).toHaveCount(0);
  await expect(browser.locator('.transcript-card [data-slot="skeleton"]')).toHaveCount(0);
  await expect(browser.locator(".detail-aside")).not.toBeVisible();
  await expect(browser.locator(".player-panel")).toHaveCount(0);
  await expect(screen.getByRole("button", { name: "版本与导出", exact: true })).toHaveCount(0);
  await app.screenshot("音频预处理加载状态");
  await browser.setViewport({ width: 375, height: 812 });
  await noOverflow(browser);
  await app.screenshot("手机音频预处理状态");
  await browser.setViewport({ width: 1440, height: 1000 });

  let writes = 0;
  let release = () => {};
  let hold: Promise<void> | undefined;
  await browser.route(`**/api/v1/recordings/${id}`, async (route) => {
    if (route.request.method === "PATCH") {
      writes++;
      if (hold) await hold;
    }
    await route.continue();
  });
  const title = screen.getByRole("button", { name: "编辑标题", exact: true });
  await title.click();
  await screen.getByLabel("标题", { exact: true }).fill("新的标题");
  // IME 的确认键不能触发提交，真正的 Enter 才保存。
  await browser.evaluate(() => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    return null;
  });
  expect(writes).toBe(0);
  await app.screenshot("紧凑标题编辑");
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await browser.keyboard.press("Enter");
    await expect(screen.getByRole("button", { name: "保存", exact: true })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await expect(screen.getByLabel("标题", { exact: true })).toBeDisabled();
    await expect(screen.getByRole("button", { name: "取消编辑", exact: true })).toBeDisabled();
    await browser.keyboard.press("Enter");
    await expect.poll(() => writes).toBe(1);
  } finally {
    release();
    hold = undefined;
  }
  await expect(screen.getByRole("heading", { name: "新的标题", exact: true })).toBeVisible();
  // InlineEdit returns focus after mounting its trigger.
  await expect
    .poll(() => browser.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null))
    .toBe("编辑标题");

  await title.click();
  await browser.keyboard.press("Enter");
  await expect(title).toBeVisible();
  expect(writes, "未修改标题不应发送 PATCH").toBe(1);

  await title.click();
  await screen.getByLabel("标题", { exact: true }).fill("保留的本地草稿");
  const before = await (await api(browser, `/recordings/${id}`)).json();
  expect(
    (
      await api(browser, `/recordings/${id}`, "PATCH", {
        revision: before.revision,
        title: "另一个会话的标题",
      })
    ).status,
  ).toBe(200);
  await browser.keyboard.press("Enter");
  await expect(screen.getByLabel("标题", { exact: true })).toHaveValue("保留的本地草稿");
  await expect(
    screen
      .getByText("同一字段已被修改，你的输入已保留。请取消编辑并核对最新内容后再保存。")
      .first(),
  ).toBeVisible();
  expect((await (await api(browser, `/recordings/${id}`)).json()).title).toBe("另一个会话的标题");
  await expect
    .poll(() => browser.evaluate(() => document.activeElement?.tagName ?? null))
    .toBe("INPUT");
  await browser.keyboard.press("Escape");
  await expect(title).toHaveText("另一个会话的标题");

  // 不同字段的并发修改允许一次重试，同时保留另一字段。
  await title.click();
  await screen.getByLabel("标题", { exact: true }).fill("合并后的标题");
  const latest = await (await api(browser, `/recordings/${id}`)).json();
  expect(
    (
      await api(browser, `/recordings/${id}`, "PATCH", {
        revision: latest.revision,
        notes: "外部备注",
      })
    ).status,
  ).toBe(200);
  await browser.keyboard.press("Enter");
  await expect(title).toHaveText("合并后的标题");
  expect((await (await api(browser, `/recordings/${id}`)).json()).notes).toBe("外部备注");
  await browser.unroute(`**/api/v1/recordings/${id}`);

  await browser.locator('button[aria-controls="recording-info"]').click();
  await expect(screen.getByRole("button", { name: "删除录音", exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "删除录音", exact: true }).click();
  await expect(screen.getByRole("alertdialog")).toBeVisible();
  await screen.getByRole("button", { name: "保留录音", exact: true }).click();
  await expect(screen.getByRole("alertdialog")).toHaveCount(0);
  expect((await api(browser, `/recordings/${id}`)).status).toBe(200);
  await browser.locator('#recording-versions > [data-slot="collapsible-trigger"]').click();
  await expect(screen.getByLabel("转写版本")).toBeVisible();
  await screen.getByRole("button", { name: "编辑备注", exact: true }).click();
  await screen.getByLabel("备注", { exact: true }).fill("第一行\n第二行");
  await browser.locator('button[aria-controls="recording-info"]').click();
  await expect(browser.locator(".detail-aside")).not.toBeVisible();
  await browser.locator('button[aria-controls="recording-info"]').click();
  await expect(screen.getByLabel("备注", { exact: true })).toHaveValue("第一行\n第二行");
  await screen.getByLabel("备注", { exact: true }).click();
  await browser.keyboard.press("Control+Enter");
  await expect(screen.getByRole("button", { name: "编辑备注", exact: true })).toHaveText(
    "第一行\n第二行",
  );

  await browser.setViewport({ width: 375, height: 812 });
  await browser.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await title.click();
  await noOverflow(browser);
  expect(
    await browser.evaluate(
      () => getComputedStyle(document.querySelector('[data-slot="spinner"]')!).animationName,
    ),
  ).toBe("none");
  await app.screenshot("手机标题编辑");
  await browser.keyboard.press("Escape");
  await browser.setViewport({ width: 1440, height: 1000 });

  // 启动真实后台 worker，预处理、转写、自动激活走实际 Go/PostgreSQL。
  await writeFile(fixture("VOICES_TEST_WORKER_GATE"), "start");
  const segment = browser.locator(".segment-text").first();
  await expect(segment).toBeVisible({ timeout: 30000 });
  await expect(screen.getByRole("tab", { name: "目录", exact: true })).toBeVisible();
  await expect(screen.getByRole("tab", { name: "摘要", exact: true })).toBeVisible();
  await expect(screen.getByLabel("录音播放器", { exact: true })).toBeVisible();
  await expect(screen.getByRole("status", { name: "正在准备音频" })).toHaveCount(0);
  await browser.evaluate(() => {
    (window as unknown as { savedAudio: Element | null }).savedAudio =
      document.querySelector("audio");
    return null;
  });
  await segment.click();
  await expect(screen.getByLabel("片段文字", { exact: true })).toHaveCount(0);
  await browser.locator(".message-more").first().click();
  await screen.getByRole("menuitem", { name: "编辑文字", exact: true }).click();
  await expect(screen.getByRole("menu")).toHaveCount(0);
  await expect(screen.getByLabel("片段文字", { exact: true })).toBeFocused();
  await screen.getByLabel("片段文字", { exact: true }).fill("共用组件修改的转写正文");
  await browser.keyboard.press("Control+Enter");
  await expect(segment).toHaveText("共用组件修改的转写正文");
  expect(
    await browser.evaluate(
      () =>
        (window as unknown as { savedAudio: Element | null }).savedAudio ===
        document.querySelector("audio"),
    ),
  ).toBe(true);
  await app.screenshot("处理完成与共用编辑组件");
  const transcriptSearch = screen.getByRole("combobox", { name: "搜索转写正文", exact: true });
  await transcriptSearch.fill("共用组件修改");
  await expect(screen.getByRole("option").first()).toBeVisible();
  await screen.getByRole("option").first().click();
  await expect(transcriptSearch).toHaveValue("共用组件修改");
  await expect(segment).toHaveText("共用组件修改的转写正文");
  await screen.getByRole("button", { name: "清除正文搜索", exact: true }).click();
  await browser.evaluate(() => {
    const content = document.querySelector('[data-slot="bubble-content"]')!;
    const rect = content.getBoundingClientRect();
    content.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: rect.left + 8,
        clientY: rect.top + 8,
      }),
    );
    return null;
  });
  await expect(screen.getByRole("menuitem", { name: "编辑文字", exact: true })).toBeVisible();
  await browser.keyboard.press("Escape");
  await expect(screen.getByRole("menu")).toHaveCount(0);

  const original = await (await api(browser, `/recordings/${id}`)).json();
  await screen.getByRole("tab", { name: "录音信息", exact: true }).click();
  await screen.getByRole("button", { name: "新建转写", exact: true }).click();
  await screen.getByRole("button", { name: "开始转写", exact: true }).click();
  await expect(screen.getByRole("dialog")).toHaveCount(0);
  await expect(segment).toHaveText("共用组件修改的转写正文");
  await expect(screen.getByText("新版本已生成", { exact: true })).toBeVisible({ timeout: 30000 });
  expect((await (await api(browser, `/recordings/${id}`)).json()).active_transcription_id).toBe(
    original.active_transcription_id,
  );
  await app.screenshot("新版本完成仍保留旧正文");
  await screen.getByRole("button", { name: "查看新版本", exact: true }).click();
  await expect(segment).not.toHaveText("共用组件修改的转写正文");
  await browser.goto(`${fixture("VOICES_TEST_URL")}/recordings/${id}`);
  await expect(segment).toHaveText("共用组件修改的转写正文");

  // 把首个说话人批量关联为系统后，其他说话人的头像与真实发言边界必须保留。
  const visibleIds = await browser.evaluate(() =>
    Array.from(document.querySelectorAll(".segment"))
      .slice(0, 4)
      .map((node) => node.id),
  );
  await browser.locator(`#${visibleIds[0]} .segment-avatar button`).click();
  await screen.getByRole("button", { name: "系统提示音 · 内置", exact: true }).click();
  await expect(browser.locator(`#${visibleIds[0]}`)).toHaveCount(0);
  await expect(browser.locator(`#${visibleIds[1]} .segment-avatar`)).toBeVisible();
  await expect(browser.locator(`#${visibleIds[3]} .segment-top`)).toBeVisible();
  await app.screenshot("隐藏系统片段后保留说话人头像");
  await screen.getByRole("tab", { name: "摘要", exact: true }).click();
  await expect(screen.getByRole("button", { name: "配置语言模型", exact: true })).toHaveAttribute(
    "href",
    "/admin/server",
  );
});

// @feature docs/feature/interface-interactions/ui.md
test("异步操作反馈、筛选空态与刷新保留内容", async ({ app, browser, screen }) => {
  const base = fixture("VOICES_TEST_URL");
  const target = fixture("VOICES_TEST_UI_USER");
  await app.open();
  await screen.getByLabel("用户名或邮箱").fill("tester@example.test");
  await screen.getByLabel("密码", { exact: true }).fill("acceptance-password");
  await screen.getByRole("button", { name: "进入工作台" }).click();
  await expect(screen.getByRole("button", { name: "导入录音" }).first()).toBeVisible();
  await browser.goto(`${base}/admin/accounts`);
  const card = browser
    .locator('[data-slot="card"]')
    .filter({ hasText: "ui_reviewer@example.test" });
  const promote = card.getByRole("button", { name: "设为管理员", exact: true });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  await browser.route(`**/api/v1/admin/users/${target}`, async (route) => {
    if (route.request.method === "PATCH") {
      writes++;
      await gate;
    }
    await route.continue();
  });
  try {
    await promote.click();
    await expect(promote).toHaveAttribute("aria-busy", "true");
    await expect(promote).toBeDisabled();
    await expect(card.getByRole("button", { name: "停用账号", exact: true })).toBeDisabled();
    await expect(browser.locator('button[aria-busy="true"]')).toHaveCount(1);
    await app.screenshot("只有当前账号操作显示加载");
    expect(writes).toBe(1);
  } finally {
    release();
  }
  await expect(card.getByRole("button", { name: "设为普通用户", exact: true })).toBeEnabled();
  await browser.unroute(`**/api/v1/admin/users/${target}`);

  // 注册开关的延迟失败不能静默，也不能留下乐观更新后的错误值。
  const registration = screen.getByRole("switch", { name: "允许创建新账号", exact: true });
  const failedGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await browser.route("**/api/v1/admin/registration", async (route) => {
    if (route.request.method === "PATCH") {
      await failedGate;
      await route.abort();
    } else await route.continue();
  });
  try {
    await expect(registration).toHaveAttribute("aria-checked", "true");
    await registration.click();
    await expect(screen.getByRole("status").filter({ hasText: "正在保存…" })).toBeVisible();
    await expect(registration).toBeDisabled();
  } finally {
    release();
  }
  await expect(registration).toBeEnabled();
  await expect(registration).toHaveAttribute("aria-checked", "true");
  await expect(
    browser
      .locator('[data-slot="toast-description"]')
      .filter({ hasText: "网络连接中断或请求超时" }),
  ).toBeVisible();
  expect((await (await api(browser, "/admin/registration")).json()).registration_open).toBe(true);
  await browser.unroute("**/api/v1/admin/registration");

  await browser.goto(`${base}/people?q=ui-no-such-person`);
  await expect(screen.getByText("没有匹配的人物", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(screen.getByText("没有匹配的人物", { exact: true })).toHaveCount(0);
  await expect(screen.getByText("暂无备注", { exact: true })).toHaveCount(0);
  await expect(
    screen.getByRole("link", { name: "背景声 内置", exact: false }).first(),
  ).toBeVisible();
  await browser.setViewport({ width: 375, height: 812 });
  await browser.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await noOverflow(browser);
  await app.screenshot("手机人物列表减少重复说明");
  await browser.setViewport({ width: 1440, height: 1000 });
  await browser.goto(`${base}/settings`);
  await expect(screen.getByRole("heading", { name: "转写偏好", exact: true })).toBeVisible();
  await expect(screen.getByRole("button", { name: "管理服务商连接", exact: true })).toHaveAttribute(
    "href",
    "/admin/server",
  );
  await app.screenshot("简化转写偏好");

  await browser.goto(`${base}/jobs?view=calls&model=ui-pagination`);
  const rows = screen.getByText("HTTP: 200", { exact: true });
  await expect(rows).toHaveCount(50);
  const refresh = screen.getByRole("button", { name: "刷新", exact: true });
  const more = screen.getByRole("button", { name: "加载更多", exact: true });
  let hold: Promise<void> | undefined;
  await browser.route("**/api/v1/calls?**", async (route) => {
    if (hold) await hold;
    await route.continue();
  });
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await refresh.click();
    await expect(refresh).toHaveAttribute("aria-busy", "true");
    await expect(rows).toHaveCount(50);
    await expect(more).not.toHaveAttribute("aria-busy", "true");
    await expect(more).toBeDisabled();
  } finally {
    release();
    hold = undefined;
  }
  await expect(refresh).toBeEnabled();
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await more.click();
    await expect(screen.getByRole("button", { name: "加载中…", exact: true })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await expect(refresh).not.toHaveAttribute("aria-busy", "true");
    await expect(rows).toHaveCount(50);
  } finally {
    release();
    hold = undefined;
  }
  await expect(rows).toHaveCount(51);
  await expect(more).toHaveCount(0);
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await screen.getByLabel("模型 ID", { exact: true }).fill("ui-no-such-model");
    await expect(rows).toHaveCount(0);
    await expect(screen.getByRole("status", { name: "正在加载", exact: true })).toBeVisible();
  } finally {
    release();
    hold = undefined;
  }
  await expect(screen.getByText("没有匹配的调用记录", { exact: true })).toBeVisible();
  await browser.unroute("**/api/v1/calls?**");
  await browser.goto(`${base}/jobs?view=calls&model=ui-fold`);
  await expect(screen.getByText("已加载 3 次", { exact: true })).toBeVisible();
  await expect(screen.getByLabel("模型 ID", { exact: true })).toBeVisible();
  await expect(screen.getByText("HTTP: 200", { exact: true })).toHaveCount(3);
  for (let index = 0; index < 3; index++) {
    await expect(screen.getByText("HTTP: 200", { exact: true }).nth(index)).toBeVisible();
  }
  await expect(screen.getByText("音频时长", { exact: true })).toHaveCount(3);
  await expect(screen.getByText("1:26:02", { exact: true })).toHaveCount(3);
  await app.screenshot("桌面调用日志与直接可见的详情");
  await browser.setViewport({ width: 375, height: 812 });
  await noOverflow(browser);
  await browser.evaluate(() => {
    document.querySelector("article")?.scrollIntoView();
    return null;
  });
  await app.screenshot("窄屏调用日志与直接可见的详情");
  const from = screen.getByLabel("开始时间", { exact: true });
  await from.fill("2020-01-02T12:30");
  await expect(from).toHaveValue("2020-01-02T12:30");
  await screen.getByRole("button", { name: "选择日期", exact: true }).first().click();
  await expect(browser.locator('[data-slot="calendar"]')).toBeVisible();
  await noOverflow(browser);
  await app.screenshot("official-date-time-picker");
  await browser.locator('[data-day="2020/1/3"]').click();
  await expect(from).toHaveValue("2020-01-03T12:30");
  await screen.getByLabel("时间", { exact: true }).fill("14:45");
  await expect(from).toHaveValue("2020-01-03T14:45");
  await screen.getByRole("button", { name: "清除", exact: true }).click();
  await expect(from).toHaveValue("");
  await expect(browser.locator('[data-slot="calendar"]')).toHaveCount(0);
  await browser.goto(`${base}/jobs`);
  await expect(screen.getByRole("heading", { name: "处理任务", exact: true })).toBeVisible();
  await expect(browser.locator('[data-slot="card"]')).toHaveCount(0);
  await noOverflow(browser);
  await app.screenshot("single-layer-task-list");
  const taskDetails = screen.getByRole("button", { name: "任务详情", exact: true }).first();
  await taskDetails.click();
  await expect(screen.getByRole("dialog", { name: "任务详情", exact: true })).toBeVisible();
  await noOverflow(browser);
  await browser.keyboard.press("Escape");
  await expect(taskDetails).toBeFocused();
  await browser.goto(`${base}/admin/server`);
  await screen.getByLabel("LLM Base URL", { exact: true }).fill("https://models.example.test/v1");
  await expect(screen.getByTestId("settings-save-status")).toHaveAttribute(
    "data-save-state",
    "saved",
  );
  await browser.route("**/api/v1/admin/llm-models", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [{ id: "alpha-model" }, { id: "beta-model" }] }),
    });
  });
  await screen.getByRole("button", { name: "获取 LLM 模型", exact: true }).click();
  const model = screen.getByPlaceholder("选择或填写模型 ID", { exact: true });
  await model.click();
  await screen.getByRole("option", { name: "alpha-model", exact: true }).click();
  await browser.keyboard.press("Tab");
  await expect(model).toHaveValue("alpha-model");
  await expect(screen.getByTestId("settings-save-status")).toHaveAttribute(
    "data-save-state",
    "saved",
  );
  await expect(
    browser.locator('[data-slot="toast-description"]').filter({ hasText: "所有修改已保存" }),
  ).toBeVisible();
  await model.fill("custom-model");
  await browser.keyboard.press("Tab");
  await expect(model).toHaveValue("custom-model");
  await expect(screen.getByTestId("settings-save-status")).toHaveAttribute(
    "data-save-state",
    "saved",
  );
  await browser.reload();
  await expect(model).toHaveValue("custom-model");
  await noOverflow(browser);
  await app.screenshot("手机服务器设置与官方模型选择器");
  await browser.unroute("**/api/v1/admin/llm-models");
});

// @use-case docs/feature/updates/use-case/check-updates.md
test("辅助信息弹窗、安全 Markdown 与焦点恢复", async ({ app, browser, screen }) => {
  await app.open();
  await screen.getByLabel("用户名或邮箱").fill("tester@example.test");
  await screen.getByLabel("密码", { exact: true }).fill("acceptance-password");
  await screen.getByRole("button", { name: "进入工作台" }).click();
  await expect(screen.getByRole("button", { name: "导入录音" }).first()).toBeVisible();
  await browser.route("**/api/v1/admin/updates", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "ok",
        current_version: "1.0.0",
        latest_version: "1.1.0",
        update_available: true,
        checked_at: "2026-11-11T12:00:00Z",
        last_success_at: "2026-11-11T12:00:00Z",
        release_url: "https://github.com/example/releases",
        release_notes:
          "# Release heading\n\n- **Strong item**\n\n```js\nconst safe = true;\n```\n\n[Allowed](https://example.com) [Blocked](javascript:alert(1))\n\n<img src=x onerror=alert(1)>\n\n![Remote image](https://example.com/image.png)\n\n" +
          "Long paragraph.\n\n".repeat(80),
        announcements: [
          {
            id: "notice",
            title: "Test notice",
            severity: "warning",
            body: "Summary\n\n## Notice detail\n\nFull announcement",
            link: null,
          },
        ],
      }),
    });
  });
  await browser.goto(`${fixture("VOICES_TEST_URL")}/admin/server`);
  const trigger = screen.getByRole("button", { name: "版本更新日志", exact: true });
  await expect(trigger).toBeVisible();
  await expect(screen.getByText("最后成功：", { exact: false })).toHaveCount(0);
  await expect(screen.getByRole("heading", { name: "Release heading" })).toHaveCount(0);
  await trigger.click();
  const dialog = screen.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Release heading" })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Allowed" })).toHaveAttribute(
    "href",
    "https://example.com",
  );
  await expect(dialog.getByRole("link", { name: "Blocked" })).toHaveCount(0);
  await expect(browser.locator('[role="dialog"] img')).toHaveCount(0);
  await expect(browser.locator('[role="dialog"] strong')).toHaveText("Strong item");
  await expect(browser.locator('[role="dialog"] pre code')).toContainText("const safe = true;");
  await browser.setViewport({ width: 375, height: 812 });
  await noOverflow(browser);
  expect(
    await browser.evaluate(() => {
      const box = document.querySelector('[role="dialog"]')!;
      return (
        box.getBoundingClientRect().height <= innerHeight &&
        Array.from(box.querySelectorAll("div")).some(
          (el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === "auto",
        )
      );
    }),
  ).toBe(true);
  await app.screenshot("mobile-scrollable-release-dialog");
  await browser.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await screen.getByRole("button", { name: "查看公告详情", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Notice detail" })).toBeVisible();
  await browser.keyboard.press("Escape");
  await expect(screen.getByRole("button", { name: "查看公告详情", exact: true })).toBeFocused();
});
