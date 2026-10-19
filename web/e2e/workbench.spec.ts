import { test, expect, type Page } from "@playwright/test";
const rid = "b7db17d4-ef27-4a00-9bcb-3fcf935dd001";
const tid = "b7db17d4-ef27-4a00-9bcb-3fcf935dd002";
const sid = "b7db17d4-ef27-4a00-9bcb-3fcf935dd003";
const pid = "b7db17d4-ef27-4a00-9bcb-3fcf935dd004";
const recording = {
  id: rid,
  title: "周末的声音",
  original_name: "weekend.wav",
  recorded_at: "2026-10-17T10:00:00Z",
  recorded_at_source: "import",
  notes: "个人访谈",
  duration_ms: 3000,
  size_bytes: 48044,
  mime_type: "audio/wav",
  state: "ready",
  active_transcription_id: "new-active-version",
  revision: 1,
  auto_transcribe: false,
  created_at: "2026-10-17T10:00:00Z",
};
const version = {
  id: tid,
  recording_id: rid,
  provider: "soniox",
  model: "test",
  options: {
    provider: "soniox",
    model: "test",
    language_mode: "single",
    languages: ["zh"],
    diarization: false,
  },
  state: "succeeded",
  error_code: null,
  revision: 1,
  created_at: "2026-10-17T10:00:00Z",
  speaker_labels: [
    {
      id: "label-1",
      transcription_id: tid,
      display_name: "Speaker 1",
      provider_label: null,
      person_id: pid,
      person_name: "张三",
      revision: 1,
    },
  ],
};
const segment = {
  id: sid,
  transcription_id: tid,
  recording_id: rid,
  ordinal: 500,
  text: "校正后的[句子]\\第二行\n结束",
  source_text: "原始句子",
  edited_text: "校正后的[句子]\\第二行\n结束",
  start_ms: 1000,
  end_ms: 1800,
  speaker_label_id: "label-1",
  speaker_name: "张三",
  person_id: pid,
  assignment_mode: "inherit",
  revision: 2,
};
const session = {
  authenticated: true,
  user: {
    id: "test-user",
    email: "tester@example.test",
    display_name: "Tester",
    role: "admin",
    status: "active",
  },
  csrf_token: "csrf-test",
  public_base_url: "http://127.0.0.1:5187/voices/",
  restore_mode: false,
};
const person = {
  id: pid,
  display_name: "张三",
  notes: "采访对象",
  archived_at: null,
  revision: 1,
  created_at: recording.created_at,
};
function wav() {
  const samples = 24000;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}
async function boundary(
  page: Page,
  options: { login?: boolean; noTime?: boolean; mismatch?: boolean; jobs?: boolean } = {},
) {
  await page.addInitScript(() => {
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
  });
  let authenticated = !options.login;
  const calls: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname.replace("/voices/api/v1", "");
    calls.push(`${req.method()} ${path}${url.search}`);
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/auth/status") return json({ initialized: true, registration_open: true });
    if (path === "/session") {
      if (req.method() === "POST") {
        authenticated = true;
        return json(session);
      }
      return authenticated
        ? json(session)
        : json({ error: { code: "unauthorized", message: "login", request_id: "r" } }, 401);
    }
    if (!authenticated)
      return json({ error: { code: "unauthorized", message: "login", request_id: "r" } }, 401);
    if (path === "/recordings" && req.method() === "POST")
      return json({ recording, existing: false }, 201);
    if (path === "/recordings") return json({ items: [recording], next_cursor: null });
    if (path === `/recordings/${rid}`) return json(recording);
    if (path === `/recordings/${rid}/transcriptions`)
      return json({ items: [version], next_cursor: null });
    if (path === `/transcriptions/${tid}`) return json(version);
    if (/^\/transcriptions\/[^/]+\/insights$/.test(path)) return json({ configured: false, insight: null });
    if (path === `/segments/${sid}` && req.method() === "PATCH")
      return json(
        { error: { code: "conflict", message: "changed", request_id: "conflict-test" } },
        409,
      );
    if (path === `/segments/${sid}`)
      return json({
        ...segment,
        ...(options.noTime ? { start_ms: null, end_ms: null } : {}),
        ...(options.mismatch ? { recording_id: "another-recording" } : {}),
      });
    if (path === `/transcriptions/${tid}/segments`)
      return json({
        items: [{ ...segment, ...(options.noTime ? { start_ms: null, end_ms: null } : {}) }],
        next_cursor: null,
        previous_cursor: null,
      });
    if (path === "/people") return json({ items: [person], next_cursor: null });
    if (path === "/providers") return json({ items: [{id:"soniox",name:"Soniox",configured:true,models:[{id:"test",name:"Test model",languages:["zh","en"],language_modes:["auto","single","multi"],diarization:true,timestamps:true,max_duration_ms:999999,max_file_bytes:999999}]}], next_cursor: null });
    if (path === "/settings") return json({ default_transcription: null, auto_transcribe: false });
    if (path === "/jobs")
      return json({
        items: options.jobs
          ? [
              {
                id: "uncertain-job",
                kind: "transcribe",
                recording_id: rid,
                transcription_id: tid,
                state: "uncertain",
                stage: "submitting",
                attempt: 1,
                error_code: "network_uncertain",
                operations: [
                  {
                    id: "upload-operation",
                    kind: "upload",
                    state: "known",
                    remote_id: "existing-file-id",
                    resolution_note: "上传已核实",
                  },
                  {
                    id: "submit-operation",
                    kind: "submit",
                    state: "uncertain",
                    remote_id: null,
                    resolution_note: "需人工查询",
                  },
                ],
                created_at: recording.created_at,
              },
            ]
          : [],
        next_cursor: null,
      });
    if (path === `/recordings/${rid}/audio`) {
      const body = wav();
      return route.fulfill({
        status: 206,
        contentType: "audio/wav",
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes 0-${body.length - 1}/${body.length}`,
        },
        body,
      });
    }
    return json({ error: { code: "not_found", message: "not found", request_id: "r" } }, 404);
  });
  return calls;
}
const deepLink = `recordings/${rid}/transcriptions/${tid}?segment=${sid}`;
// @use-case docs/feature/sentence-links/use-case/copy-sentence-link.md
test("带前缀的历史版本深链接：鉴权后保留锚点、真实音频 seek、不自动播放、手动复制", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    }),
  );
  const calls = await boundary(page, { login: true });
  await page.goto(deepLink);
  await expect(page.getByLabel("密码", { exact: true })).toBeVisible();
  await page.getByLabel(/^(用户名或邮箱|邮箱)$/, { exact: true }).fill("tester@example.test");
  await page.getByLabel("密码", { exact: true }).fill("test-only-password");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page).toHaveURL(new RegExp(`transcriptions/${tid}\\?segment=${sid}`));
  const anchor = page.locator(`#segment-${sid}`);
  await expect(anchor).toHaveClass(/segment-highlight/);
  await expect(anchor).toContainText("校正后的[句子]");
  expect(calls.some((call) => call.includes(`anchor_id=${sid}`))).toBe(true);
  expect(calls.some((call) => call.includes("/transcriptions/new-active-version"))).toBe(false);
  await expect
    .poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.currentTime))
    .toBeCloseTo(1, 1);
  expect(await page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(
    true,
  );
  await page.screenshot({ path: "test-results/detail-desktop.png", fullPage: true });
  await anchor.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menuitem", { name: "复制引用" }).click();
  await expect(page.getByRole("dialog", { name: "手动复制" })).toBeVisible();
  await expect(page.getByLabel("引用内容")).toHaveValue(
    `[张三: 校正后的\\[句子\\]\\\\第二行 结束](http://127.0.0.1:5187/voices/recordings/${rid}/transcriptions/${tid}?segment=${sid})`,
  );
});
// @use-case docs/feature/sentence-links/use-case/copy-sentence-link.md
test("无时间戳仍定位并编辑文本，冲突不会覆盖", async ({ page }) => {
  const calls = await boundary(page, { noTime: true });
  await page.goto(deepLink);
  const anchor = page.locator(`#segment-${sid}`);
  await expect(anchor.getByRole("button", { name: /播放/ })).toBeDisabled();
  await page.getByRole("tab",{name:"录音信息",exact:true}).click();
  await page.locator("summary").filter({hasText:"版本与导出"}).click();
  await expect(page.getByRole("button", { name: "SRT", exact: true })).toBeDisabled();
  await anchor.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click();
  await page.getByLabel("文字", { exact: true }).fill("新的人工校正");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByText("内容已发生变化或请求冲突。请刷新最新内容后重新编辑，不会覆盖他人的修改。", {
        exact: true,
      }),
  ).toBeVisible();
  expect(calls.filter((c) => c === `PATCH /segments/${sid}`)).toHaveLength(1);
  await expect(page.getByRole("dialog", { name: "编辑片段" })).toBeVisible();
});
// @use-case docs/feature/sentence-links/use-case/copy-sentence-link.md
test("归属不匹配时明确报错，不展示错误句子或回退版本", async ({ page }) => {
  const calls = await boundary(page, { mismatch: true });
  await page.goto(deepLink);
  await expect(page.getByText("该引用的录音、转写版本与片段不匹配，无法打开。")).toBeVisible();
  await expect(page.locator(`#segment-${sid}`)).toHaveCount(0);
  expect(calls.some((call) => call.includes("/transcriptions/new-active-version"))).toBe(false);
});
// @use-case docs/feature/recording-library/use-case/import-audio.md
test("真实 XHR 上传 metadata 在 file 之前，自动转写并刷新录音库", async ({ page }) => {
  await boundary(page);
  await page.goto("recordings");
  await page.getByRole("button", { name: "导入录音", exact: true }).first().click();
  await page
    .getByLabel("选择音频文件")
    .setInputFiles([{ name: "sample.wav", mimeType: "audio/wav", buffer: wav() }]);
  const sent = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith("/api/v1/recordings"),
  );
  await page.getByRole("button", { name: "开始导入" }).click();
  const req = await sent;
  expect(req.headers()["x-csrf-token"]).toBe("csrf-test");
  expect(req.headers()["idempotency-key"]).toMatch(/^[\da-f-]{36}$/);
  const body = req.postDataBuffer()!.toString();
  expect(body.indexOf('name="metadata"')).toBeLessThan(body.indexOf('name="file"'));
  expect(body).toContain('"auto_transcribe":true');
  expect(body).toContain('"diarization":true');
  await expect(page.getByRole("dialog", { name: "导入录音", exact: true })).toHaveCount(0);
  await expect(page.getByText("已导入 1 个文件", { exact: true })).toBeVisible();
});
// @use-case docs/feature/transcription/use-case/transcribe.md
test("uncertain 任务只有核对入口，不提供普通 retry，保存观察不新建转写", async ({ page }) => {
  const calls = await boundary(page, { jobs: true });
  await page.route("**/jobs/uncertain-job/resolve", (route) => route.fulfill({ status: 202 }));
  await page.goto("jobs");
  await expect(page.getByRole("button", { name: "恢复安全阶段" })).toHaveCount(0);
  await page.getByRole("button", { name: "登记核对结果" }).click();
  await page.getByLabel("核对的远端操作").selectOption("submit-operation");
  await expect(page.getByText("既有核对说明：需人工查询")).toBeVisible();
  await page.getByLabel("核对说明").fill("在控制台暂未查到，继续保留待确认。");
  const sent = page.waitForRequest((r) => r.url().endsWith("/resolve"));
  await page.getByRole("button", { name: "保存核对记录" }).click();
  const req = await sent;
  expect(req.postDataJSON()).toEqual({
    operation_id: "submit-operation",
    note: "在控制台暂未查到，继续保留待确认。",
  });
  await expect(page.getByRole("dialog", { name: "登记远端 ID 或查询观察" })).toHaveCount(0);
  expect(calls.some((c) => c.startsWith("POST ") && c.includes("/transcriptions"))).toBe(false);
});
// @feature docs/feature/recording-library/README.md
test("移动端录音库无横向溢出且导航可用", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boundary(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("recordings");
  await expect(page.getByRole("heading", { name: "录音库", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole("link", { name: "人物", exact: true }).click();
  await expect(page.getByRole("heading", { name: "人物", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/people-mobile.png", fullPage: true });
});

// @feature docs/feature/recording-library/README.md
test("日期筛选保留本地日期，搜索与分页使用真实 query", async ({ page }) => {
  const calls = await boundary(page);
  await page.goto("recordings");
  await page.getByText("日期范围", { exact: true }).click();
  await page.getByLabel("开始日期").fill("2026-10-18");
  await expect(page.getByLabel("开始日期")).toHaveValue("2026-10-18");
  await page.getByLabel("结束日期").fill("2026-10-19");
  await expect(page.getByLabel("结束日期")).toHaveValue("2026-10-19");
  await page.getByLabel("搜索标题").fill("周末");
  await expect.poll(() => calls.some((c) => c.includes("q=%E5%91%A8%E6%9C%AB"))).toBe(true);
  await expect(page.getByRole("link", { name: /周末的声音/ })).toBeVisible();
  await page.screenshot({ path: "test-results/library-desktop.png", fullPage: true });
});

// @use-case docs/feature/transcription/use-case/transcribe.md
test("新建转写处理 202 JSON 并进入新版本，携带用户授权与幂等键", async ({ page }) => {
  await boundary(page);
  const createdId = "b7db17d4-ef27-4a00-9bcb-3fcf935dd005";
  await page.route("**/api/v1/providers", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            id: "soniox",
            name: "Soniox",
            configured: true,
            models: [
              {
                id: "test",
                name: "Test model",
                languages: ["zh", "en"],
                language_modes: ["auto", "single", "multi"],
                diarization: true,
                timestamps: true,
                max_duration_ms: 999999,
                max_file_bytes: 999999,
              },
            ],
          },
        ],
        next_cursor: null,
      }),
    }),
  );
  await page.route("**/api/v1/transcriptions/" + createdId, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...version, id: createdId, state: "queued", speaker_labels: [] }),
    }),
  );
  await page.route("**/api/v1/transcriptions/" + createdId + "/segments?*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [], next_cursor: null, previous_cursor: null }),
    }),
  );
  await page.route("**/api/v1/recordings/" + rid + "/transcriptions", async (route) => {
    if (route.request().method() === "POST")
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          transcription: { ...version, id: createdId, state: "queued" },
          job: { id: "new-job" },
        }),
      });
    return route.fallback();
  });
  await page.goto(deepLink);
  await page.getByRole("button", { name: "新建转写", exact: true }).click();
  await page.getByLabel("转写服务商").selectOption("soniox");
  await page.getByLabel("模型", { exact: true }).selectOption("test");
  const sent = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith("/transcriptions"),
  );
  await page.getByRole("button", { name: "开始转写", exact: true }).click();
  const req = await sent;
  expect(req.headers()["idempotency-key"]).toMatch(/^[\da-f-]{36}$/);
  expect(req.postDataJSON()).toEqual({
    provider: "soniox",
    model: "test",
    language_mode: "auto",
    languages: [],
    diarization: true,
  });
  await expect(page).toHaveURL(new RegExp("transcriptions/" + createdId + "$"));
  await expect(page.getByText("转写处理中", { exact: true })).toBeVisible();
});

// @use-case docs/feature/recording-library/use-case/import-audio.md
test("拖入批量文件不重复排队，单文件失败可用原幂等键重传", async ({ page }) => {
  await boundary(page);
  const failedKeys: string[] = [];
  const uploadKeys: string[] = [];
  let failures = 0;
  await page.route("**/api/v1/recordings", async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.fallback();
    uploadKeys.push(req.headers()["idempotency-key"]);
    if (req.postDataBuffer()!.toString().includes("retry.wav")) {
      failedKeys.push(req.headers()["idempotency-key"]);
      if (failures++ === 0)
        return route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "invalid_audio",
              message: "此音频无法探测，请确认文件完整。",
              request_id: "test-audio",
            },
          }),
        });
    }
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ recording, existing: false }),
    });
  });
  await page.goto("recordings");
  const data = await page.evaluateHandle((raw) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(raw)], "first.wav", { type: "audio/wav" }));
    transfer.items.add(new File([new Uint8Array(raw)], "retry.wav", { type: "audio/wav" }));
    return transfer;
  }, Array.from(wav()));
  await page.locator(".library-drop").dispatchEvent("drop", { dataTransfer: data });
  await expect(page.locator(".upload-file")).toHaveCount(2);
  await page.getByRole("button", { name: "开始导入", exact: true }).evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(page.locator('.upload-file').getByText("此音频无法探测，请确认文件完整。（请求 test-audio）", { exact: true })).toBeVisible();
  await expect(page.locator('[data-slot=toast-description]').filter({ hasText: 'retry.wav：此音频无法探测' })).toBeVisible();
  await page.locator('[data-slot=toast-close]').click();
  await page.getByRole("button", { name: "重新上传", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "导入录音", exact: true })).toHaveCount(0);
  await expect(page.getByText("已导入 2 个文件", { exact: true })).toBeVisible();
  expect(failedKeys).toHaveLength(2);
  expect(failedKeys[0]).toBe(failedKeys[1]);
  expect(uploadKeys).toHaveLength(3);
  expect(new Set(uploadKeys).size).toBe(2);
});

// @feature docs/feature/recording-library/README.md
for (const sameField of [false, true]) {
  test(`录音页内编辑${sameField ? '保留同字段冲突草稿' : '安全合并后台状态更新'}`, async ({ page }) => {
    await boundary(page);
    let latest = { ...recording };
    const writes: Record<string, unknown>[] = [];
    await page.route(`**/api/v1/recordings/${rid}`, async (route) => {
      if (route.request().method() === 'PATCH') {
        const body = route.request().postDataJSON();
        writes.push(body);
        if (body.revision !== latest.revision) return route.fulfill({status:409,json:{error:{code:'conflict',message:'changed'}}});
        latest = { ...latest, ...body, revision: latest.revision + 1 };
      }
      await route.fulfill({json:latest});
    });
    await page.goto(`recordings/${rid}/transcriptions/${tid}`);
    await page.getByRole('button',{name:'编辑信息',exact:true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByLabel('标题',{exact:true}).fill('更新后的标题');
    await page.getByRole('tab',{name:'目录',exact:true}).click();
    await page.getByRole('tab',{name:'录音信息',exact:true}).click();
    await expect(page.getByLabel('标题',{exact:true})).toHaveValue('更新后的标题');
    latest = { ...latest, revision: 2, ...(sameField ? {title:'另一设备的修改'} : {}) };
    await page.getByRole('button',{name:'保存',exact:true}).click();
    if (sameField) {
      await expect(page.getByLabel('标题',{exact:true})).toHaveValue('更新后的标题');
      await expect(page.getByText('同一字段已被修改，你的输入已保留。请取消编辑并核对最新内容后再保存。').first()).toBeVisible();
      expect(writes).toHaveLength(1);
      expect(latest.title).toBe('另一设备的修改');
    } else {
      await expect(page.getByRole('heading',{name:'更新后的标题',exact:true})).toBeVisible();
      expect(writes).toEqual([{revision:1,title:'更新后的标题'},{revision:2,title:'更新后的标题'}]);
      expect(latest.recorded_at).toBe(recording.recorded_at);
    }
  });
}

// @use-case docs/feature/transcription/use-case/transcribe.md
for (const crossPage of [false, true]) {
  test(`点击句子仅播放本句${crossPage ? '（页尾）' : ''}`, async ({ page }) => {
    await boundary(page);
    const next = { ...segment, id:'next-segment', ordinal:501, start_ms:1900, end_ms:2600, text:'下一句' };
    let fetchedNext = false;
    await page.route(`**/api/v1/transcriptions/${tid}/segments?*`, async (route) => {
      const isNext = new URL(route.request().url()).searchParams.get('cursor') === 'next-page';
      if (isNext) fetchedNext = true;
      await route.fulfill({json:{items:isNext ? [next] : crossPage ? [segment] : [segment,next],next_cursor:crossPage && !isNext ? 'next-page' : null,previous_cursor:null}});
    });
    await page.goto(deepLink);
    const audio = page.locator('audio');
    await expect.poll(() => audio.evaluate((a:HTMLAudioElement) => a.readyState)).toBeGreaterThan(0);
    await page.locator(`#segment-${sid}`).getByRole('button',{name:/播放 .* 至本句结束/}).click();
    await expect.poll(() => audio.evaluate((a:HTMLAudioElement) => a.paused)).toBe(false);
    await expect.poll(() => audio.evaluate((a:HTMLAudioElement) => a.paused)).toBe(true);
    expect(await audio.evaluate((a:HTMLAudioElement) => a.currentTime)).toBeCloseTo(1.8,1);
    if (crossPage) await expect.poll(() => fetchedNext).toBe(true);
    else expect(fetchedNext).toBe(false);
  });
}

// @use-case docs/feature/people/use-case/link-person.md
test("手机聊天分组、原位文字编辑和双向滚动加载保留内容", async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  await boundary(page);
  const rows = Array.from({length:90}, (_, ordinal) => ({...segment,id:`chat-${ordinal}`,ordinal,text:`消息 ${ordinal}`,person_id:pid,speaker_label_id:'label-1'}));
  await page.route(`**/api/v1/transcriptions/${tid}/segments?*`, async (route) => {
    const query = new URL(route.request().url()).searchParams;
    const offset = query.has('cursor') ? Number(Buffer.from(query.get('cursor')!, 'base64url').toString()) : 30;
    const items = rows.slice(offset,offset+30);
    await route.fulfill({json:{items,current_cursor:Buffer.from(String(offset)).toString('base64url'),previous_cursor:offset>0 ? Buffer.from(String(Math.max(0,offset-30))).toString('base64url') : null,next_cursor:offset+30<rows.length ? Buffer.from(String(offset+30)).toString('base64url') : null}});
  });
  await page.route(`**/api/v1/segments/chat-40`, async (route) => {
    if (route.request().method()==='PATCH') {
      const body = route.request().postDataJSON();
      expect(Object.keys(body).sort()).toEqual(['edited_text','revision']);
      rows[40] = {...rows[40],text:body.edited_text,edited_text:body.edited_text,revision:3};
    }
    await route.fulfill({json:rows[40]});
  });
  await page.goto(`recordings/${rid}/transcriptions/${tid}?segment=chat-40`);
  const target = page.locator('#segment-chat-40');
  await expect(target).toBeVisible();
  await expect(target).toHaveClass(/segment-continuation/);
  await expect(target.locator(':scope > .segment-avatar')).toHaveCSS('visibility','hidden');
  await expect(page.locator('#segment-chat-59 > .segment-avatar')).toHaveCSS('visibility','visible');
  await target.getByRole('button',{name:'编辑这段文字'}).click();
  await page.getByLabel('片段文字',{exact:true}).fill('手机原位编辑');
  await page.getByRole('button',{name:'保存文字'}).click();
  await expect(target).toContainText('手机原位编辑');
  await expect(page.getByRole('dialog',{name:'编辑片段',exact:true})).toHaveCount(0);
  await page.locator('.segments > article').last().scrollIntoViewIfNeeded();
  await expect(page.locator('#segment-chat-89')).toHaveCount(1);
  await expect(target).toHaveCount(1);
  if (await page.locator('#segment-chat-0').count() === 0) await page.getByText('向上滚动加载更多',{exact:true}).scrollIntoViewIfNeeded();
  await expect(page.locator('#segment-chat-0')).toHaveCount(1);
  await expect(page.locator('#segment-chat-89')).toHaveCount(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

// @use-case docs/feature/transcription/use-case/transcribe.md
test("长按消息打开操作菜单，滑动不误触，轻点仍可原位编辑", async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  await boundary(page);
  await page.goto(`recordings/${rid}/transcriptions/${tid}`);
  const text = page.locator(`#segment-${sid}`).getByRole('button',{name:'编辑这段文字'});
  await text.scrollIntoViewIfNeeded();
  const cdp = await page.context().newCDPSession(page);
  const box = (await text.boundingBox())!;
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+10,y:box.y+10}]});
  await expect(page.locator(`#segment-${sid} .segment-bubble`)).toHaveAttribute('data-menu-open','true');
  await expect(page.getByRole('menuitem',{name:'复制文字',exact:true})).toBeVisible();
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await text.dispatchEvent('click');
  await expect(page.getByLabel('片段文字',{exact:true})).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+10,y:box.y+10}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:box.x+10,y:box.y+50}]});
  await page.waitForTimeout(600);
  await expect(page.getByRole('menu')).toHaveCount(0);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  const moved = (await text.boundingBox())!;
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:moved.x+10,y:moved.y+10}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
  await page.waitForTimeout(600);
  await expect(page.getByRole('menu')).toHaveCount(0);
  await text.click({button:'right'});
  await expect(page.getByRole('menuitem',{name:'播放本句',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');
  await text.click();
  await expect(page.getByLabel('片段文字',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

// @use-case docs/feature/transcription/use-case/transcribe.md
test('群聊头像和菜单换人、紧凑编辑与跨日时间校准', async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  await boundary(page);
  let current = {...recording, recorded_at:'2026-10-17T15:59:58Z', recorded_at_source:'user'};
  let assigned = false;
  await page.route(`**/api/v1/recordings/${rid}`, async route => {
    if (route.request().method() === 'PATCH') current = {...current,...route.request().postDataJSON(),revision:current.revision+1};
    await route.fulfill({json:current});
  });
  await page.route(`**/api/v1/speaker-labels/label-1`, async route => {
    assigned = route.request().postDataJSON().person_id === pid;
    await route.fulfill({json:version.speaker_labels[0]});
  });
  await page.route(`**/api/v1/transcriptions/${tid}/segments?*`, route => route.fulfill({json:{items:[{...segment,text:'你好。',edited_text:null},{...segment,id:'next',text:'下一句。',start_ms:3000,edited_text:null}],next_cursor:null,previous_cursor:null}}));
  await page.goto(`recordings/${rid}/transcriptions/${tid}`);
  const first = page.locator(`#segment-${sid}`);
  const last = page.locator('#segment-next');
  await expect(first.locator('.message-time')).toHaveAttribute('title', /23:59:59/);
  await expect(last.locator('.message-time')).toHaveAttribute('title', /00:00:01/);
  await expect(first.locator('.message-time')).toHaveText('');
  await expect(page.locator('.chat-date')).toHaveText(['2026/10/17','2026/10/18']);
  await last.locator('.speaker-avatar-trigger').click();
  await expect(page.getByText('选择人物',{exact:true})).toBeVisible();
  await expect(page.locator('[data-slot=popover-content] [data-slot=avatar]')).toHaveCount(1);
  await page.getByRole('button',{name:'张三',exact:true}).click();
  expect(assigned).toBe(true);
  await first.locator('.segment-text').click({button:'right'});
  await page.getByRole('menuitem',{name:'更换人物'}).click();
  await expect(page.getByText('选择人物',{exact:true})).toBeVisible();
  await page.keyboard.press('Escape');
  await first.locator('.segment-text').click();
  const editor = page.getByLabel('片段文字',{exact:true});
  await expect(editor).toBeVisible();
  expect((await editor.boundingBox())!.height).toBeLessThan(50);
  expect((await first.locator('.segment-bubble').boundingBox())!.width).toBeLessThan(240);
  await page.screenshot({path:'/tmp/voices-chat-edit.png'});
  await page.getByRole('button',{name:'取消编辑'}).click();
  await page.getByRole('tab',{name:'录音信息',exact:true}).click();
  await page.getByRole('button',{name:'校准时间',exact:true}).click();
  await page.getByLabel('录音开始时间',{exact:true}).fill('2026-10-18T10:20:30');
  await page.getByRole('region',{name:'编辑录音信息'}).getByRole('button',{name:'保存',exact:true}).click();
  await expect(first.locator('.message-time')).toHaveAttribute('title', /10:20:31/);
  await expect(page.locator('.chat-date')).toHaveText(['2026/10/18']);
  await expect(first.locator('.message-time')).toHaveAttribute('aria-label','播放 00:01 至本句结束');
  await first.scrollIntoViewIfNeeded();
  await page.screenshot({path:'/tmp/voices-chat-mobile.png'});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

// @use-case docs/feature/transcription/use-case/transcribe.md
test('未改文字或改后撤回等同取消，不保存也不标记校正', async ({page}) => {
  await boundary(page);
  let patches = 0;
  const unchanged = {...segment,text:'没有改动',source_text:'没有改动',edited_text:'没有改动'};
  await page.route(`**/api/v1/transcriptions/${tid}/segments?*`, route => route.fulfill({json:{items:[unchanged],next_cursor:null,previous_cursor:null}}));
  await page.route(`**/api/v1/segments/${sid}`, route => {
    if (route.request().method() === 'PATCH') patches++;
    return route.fulfill({json:unchanged});
  });
  await page.goto(`recordings/${rid}/transcriptions/${tid}`);
  const row = page.locator(`#segment-${sid}`);
  await expect(row.locator('.message-edited')).toHaveCount(0);
  await row.locator('.segment-text').click();
  await page.getByRole('button',{name:'保存文字',exact:true}).click();
  await expect(row.locator('textarea')).toHaveCount(0);
  expect(patches).toBe(0);
  await row.locator('.segment-text').click();
  await page.getByLabel('片段文字',{exact:true}).fill('暂时改动');
  await page.getByLabel('片段文字',{exact:true}).fill('没有改动');
  await page.getByLabel('片段文字',{exact:true}).press('Control+Enter');
  await expect(row.locator('textarea')).toHaveCount(0);
  expect(patches).toBe(0);
  await row.locator('.segment-text').click({button:'right'});
  await page.getByRole('menuitem',{name:'编辑',exact:true}).click();
  await page.getByRole('dialog',{name:'编辑片段',exact:true}).getByRole('button',{name:'保存修改',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'编辑片段',exact:true})).toHaveCount(0);
  expect(patches).toBe(0);
});

// @use-case docs/feature/insights/use-case/generate-insights.md
test('未配置 LLM 时桌面和手机目录提示配置，滚动不影响底部播放器', async ({page}) => {
  await boundary(page);
  const rows = Array.from({length:18}, (_,index) => ({...segment,id:`outline-${index}`,ordinal:index,start_ms:index*60000,text:`第 ${index+1} 段录音正文。` }));
  await page.route(`**/api/v1/transcriptions/${tid}/segments?*`, route => route.fulfill({json:{items:rows,next_cursor:null,previous_cursor:null}}));
  await page.goto(`recordings/${rid}/transcriptions/${tid}`);
  const target = page.locator('#segment-outline-17');
  await expect(target).toHaveCount(1);
  await page.evaluate(()=> { (window as any).testAudio = document.querySelector('audio'); });
  await expect(page.locator('.detail-aside')).toHaveCSS('overflow-y','visible');
  await expect(page.locator('.desktop-outline')).toContainText('请先配置 LLM');
  await expect(page.locator('.desktop-outline')).toContainText('请管理员在服务器设置中配置 LLM 地址和模型，并重启服务使其生效。');
  await expect(page.locator('.desktop-outline nav')).toHaveCount(0);
  await expect(page.locator('.transcript-outline')).toHaveCount(0);
  await expect(page.getByRole('tabpanel')).toHaveCSS('overflow-y','auto');
  await target.scrollIntoViewIfNeeded();
  await expect(target).toBeInViewport();
  await expect(page.getByRole('tab',{name:'目录',exact:true})).toBeInViewport();
  await expect(page.locator('.player-panel')).toHaveCSS('position','fixed');
  expect((await page.locator('.player-panel').boundingBox())!.y).toBeGreaterThan(0);
  expect(await page.evaluate(()=> (window as any).testAudio === document.querySelector('audio') && (document.querySelector('audio') as HTMLAudioElement).paused)).toBe(true);
  await page.screenshot({path:'/tmp/voices-fixed-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  await page.locator('.player-panel').getByRole('button',{name:'目录',exact:true}).click();
  await expect(page.locator('[data-slot=popover-content]')).toContainText('请先配置 LLM');
  await expect(page.locator('[data-slot=popover-content] nav')).toHaveCount(0);
  await expect(page.locator('[data-slot=popover-content]')).toContainText('请管理员在服务器设置中配置 LLM 地址和模型，并重启服务使其生效。');
  await page.keyboard.press('Escape');
  const box = (await page.locator('.player-panel').boundingBox())!;
  expect(box.y+box.height).toBeLessThanOrEqual(844);
  expect(box.y).toBeGreaterThan(650);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(await page.evaluate(()=> (window as any).testAudio === document.querySelector('audio') && (document.querySelector('audio') as HTMLAudioElement).paused)).toBe(true);
  await page.screenshot({path:'/tmp/voices-fixed-mobile.png'});
});

// @use-case docs/feature/appearance/use-case/change-theme.md
test('主题跟随系统、手动覆盖、刷新与跨标签同步', async ({ page, context }) => {
  await boundary(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('account');
  const theme = page.getByRole('combobox', { name: '界面主题' });
  await expect(theme).toHaveValue('system');
  await expect(page.locator('html')).toHaveClass('dark');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass('dark');
  await theme.selectOption('dark');
  await page.reload();
  await expect(theme).toHaveValue('dark');
  await expect(page.locator('html')).toHaveClass('dark');
  const other = await context.newPage();
  await boundary(other);
  await other.goto('account');
  await other.getByLabel('界面主题').selectOption('light');
  await expect(theme).toHaveValue('light');
  await expect(page.locator('html')).not.toHaveClass('dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).not.toHaveClass('dark');
  await other.evaluate(() => localStorage.clear());
  await expect(theme).toHaveValue('system');
  await expect(page.locator('html')).toHaveClass('dark');
  await other.close();
});

// @use-case docs/feature/appearance/use-case/change-theme.md
test('主题初始化在应用加载前完成且存储不可用仍可切换', async ({ page }) => {
  await boundary(page, { login: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } });
  });
  await page.route('**/src/main.tsx', route => route.abort());
  await page.route('**/voices/login', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'" } });
  });
  await page.goto('login');
  await expect(page.locator('html')).toHaveClass('dark');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#171b24');
  await expect(page.locator('#root')).toBeEmpty();
  await page.unroute('**/src/main.tsx');
  await page.unroute('**/voices/login');
  await page.reload();
  await expect(page.getByLabel('界面主题')).toHaveCount(0);
  await page.getByLabel('用户名或邮箱').fill('tester@example.test');
  await page.getByLabel('密码', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: '进入工作台', exact: true }).click();
  await page.getByRole('link', { name: '我的账号', exact: true }).click();
  await page.getByLabel('界面主题').selectOption('light');
  await expect(page.locator('html')).not.toHaveClass('dark');
});

// @use-case docs/feature/appearance/use-case/change-theme.md
test('主题在手机个人设置切换并应用于工作台、导入弹窗与转写详情', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await boundary(page, { login: true });
  await page.goto('login');
  await expect(page.getByLabel('界面主题')).toHaveCount(0);
  await page.getByLabel('用户名或邮箱').fill('tester@example.test');
  await page.getByLabel('密码', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: '进入工作台', exact: true }).click();
  await page.getByRole('link', { name: '我的账号', exact: true }).click();
  await page.getByLabel('界面主题').selectOption('light');
  await page.getByLabel('界面主题').selectOption('dark');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/voices-theme-account-mobile.png', fullPage: true });
  await page.getByRole('link', { name: '录音库', exact: true }).click();
  await expect(page.getByLabel('界面主题')).toHaveCount(0);
  await page.getByRole('button', { name: '导入录音', exact: true }).first().click();
  await expect(page.getByRole('dialog', { name: '导入录音', exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/voices-dark-dialog.png', fullPage: true });
  await page.keyboard.press('Escape');
  await page.goto(`recordings/${rid}/transcriptions/${tid}`);
  await expect(page.locator('.segment-bubble').first()).toBeVisible();
  await expect(page.locator('html')).toHaveClass('dark');
  await page.screenshot({ path: '/tmp/voices-dark-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: '/tmp/voices-dark-desktop.png', fullPage: true });
});

// @use-case docs/feature/interface-language/use-case/choose-language.md
test("英文转写详情保留中文正文并翻译未分配说话人", async ({ page }) => {
  await boundary(page);
  await page.route('**/api/v1/session', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ ...session, user: { ...session.user, ui_language: 'en' } }),
  }));
  const unknown = { ...segment, person_id: null, speaker_label_id: null, speaker_name: '未知说话人' };
  await page.route(`**/api/v1/segments/${sid}`, route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(unknown) }));
  await page.route(`**/api/v1/transcriptions/${tid}/segments?*`, route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ items: [unknown], next_cursor: null, previous_cursor: null }),
  }));
  await page.goto(deepLink);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByText('Unknown speaker', { exact: true })).toBeVisible();
  await expect(page.locator('.segment-text')).toHaveText(segment.text);
  await expect(page.getByRole('heading', { name: recording.title, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play from 00:01 to the end of this sentence', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
