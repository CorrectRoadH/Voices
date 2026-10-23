import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { writeFile } from "node:fs/promises";
import { api, fixture, noOverflow } from "./support/session";

// @use-case docs/feature/transcription/use-case/transcribe.md
test("加载阶段、行内编辑快捷键、保存状态与真实并发冲突", async ({ app, browser, screen }) => {
  const id = fixture("VOICES_TEST_RECORDING");
  await app.open();
  await screen.getByLabel("用户名或邮箱").fill("tester@example.test");
  await screen.getByLabel("密码", { exact: true }).fill("acceptance-password");
  await screen.getByRole("button", { name: "进入工作台" }).click();
  await expect(screen.getByRole("button", { name: "导入录音" }).first()).toBeVisible();
  await browser.goto(`${fixture("VOICES_TEST_URL")}/recordings/${id}`);
  await expect(screen.getByRole("status", { name: "正在准备音频" })).toBeVisible();
  await expect(screen.getByText("暂无转写", { exact: true })).toHaveCount(0);
  await screen.getByRole("tab", { name: "摘要", exact: true }).click();
  await expect(screen.getByText("尚未生成摘要", { exact: true })).toBeVisible();
  await expect(screen.getByText("完成转写后可生成摘要。", { exact: true })).toBeVisible();
  await screen.getByRole("tab", { name: "目录", exact: true }).click();
  await app.screenshot("音频预处理加载状态");

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
  expect(
    await browser.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null),
  ).toBe("编辑标题");

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

  await screen.getByRole("button", { name: "版本与导出", exact: true }).click();
  await expect(screen.getByLabel("转写版本")).toBeVisible();
  await screen.getByRole("button", { name: "编辑备注", exact: true }).click();
  await screen.getByLabel("备注", { exact: true }).fill("第一行\n第二行");
  await screen.getByRole("tab", { name: "摘要", exact: true }).click();
  await screen.getByRole("tab", { name: "录音信息", exact: true }).click();
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
  const segment = screen.getByRole("button", { name: "编辑这段文字", exact: true }).first();
  await expect(segment).toBeVisible({ timeout: 30000 });
  await expect(screen.getByRole("status", { name: "正在准备音频" })).toHaveCount(0);
  await browser.evaluate(() => {
    (window as unknown as { savedAudio: Element | null }).savedAudio =
      document.querySelector("audio");
    return null;
  });
  await segment.click();
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
  // 把首个说话人批量关联为系统后，其他说话人的头像与真实发言边界必须保留。
  const visibleIds = await browser.evaluate(() =>
    Array.from(document.querySelectorAll("article.segment"))
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

// @feature docs/feature/appearance/README.md
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
    browser.locator('[data-slot="alert"]').filter({ hasText: "网络连接中断或请求超时" }),
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
  await browser.emulateMedia({ colorScheme: "dark" });
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
  await expect(screen.getByText("暂无调用记录", { exact: true })).toBeVisible();
  await browser.unroute("**/api/v1/calls?**");
});
