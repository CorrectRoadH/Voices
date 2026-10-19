// Real browser + HTTP handlers + isolated PostgreSQL. Only failure injection uses the network boundary.
import { chromium, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
const base = process.env.VOICES_TEST_URL;
const password = 'test-language-password';
const errors = [];
const watch = page => page.on('pageerror', error => errors.push(error.message));
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, colorScheme: 'dark' });
  const page = await context.newPage(); watch(page);
  await page.goto(base);
  await expect(page).toHaveTitle('Voices');
  await page.getByLabel('界面语言', { exact: true }).selectOption('en');
  await expect(page.getByText('Create administrator account', { exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.reload();
  await expect(page.getByLabel('Interface language', { exact: true })).toHaveValue('en');
  await page.getByLabel('Email', { exact: true }).fill('language-admin@example.test');
  await page.getByLabel('Username', { exact: true }).fill('language_admin');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  // The explicitly selected registration language seeds the new account.
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByRole('link', { name: 'My account', exact: true }).click();
  await page.getByLabel('Interface language', { exact: true }).selectOption('zh-CN');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await page.getByRole('link', { name: '我的账号', exact: true }).click();
  await page.getByLabel('显示名称', { exact: true }).fill('中文用户名');
  await page.route('**/api/v1/me', async route => {
    if (route.request().method() === 'PATCH' && route.request().postDataJSON().ui_language) await route.abort('failed');
    else await route.continue();
  });
  await page.getByLabel('界面语言', { exact: true }).selectOption('en');
  await expect(page.locator('[data-slot=toast-description]').filter({ hasText: '网络连接中断或请求超时' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.getByLabel('界面语言', { exact: true })).toHaveValue('zh-CN');
  await page.locator('[data-slot=toast-close]').click();
  await expect(page.locator('[data-slot=toast-description]').filter({ hasText: '网络连接中断或请求超时' })).toHaveCount(0);
  await page.unroute('**/api/v1/me');
  // The exact same draft input DOM node survives the successful language switch.
  const input = await page.getByLabel('显示名称', { exact: true }).elementHandle();
  await page.getByLabel('界面语言', { exact: true }).selectOption('en');
  await expect(page.getByRole('heading', { name: 'My account', exact: true })).toBeVisible();
  await expect(page.getByText('Interface language saved', { exact: true })).toBeVisible();
  expect(await input.evaluate(node => node.isConnected)).toBe(true);
  await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('中文用户名');
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(page.locator('[data-slot=toast-description]').filter({ hasText: 'Profile saved' })).toBeVisible();
  await page.locator('[data-slot=toast]').filter({ hasText: 'Profile saved' }).locator('[data-slot=toast-close]').click();
  await page.reload();
  await expect(page.getByLabel('Interface language', { exact: true })).toHaveValue('en');
  const session = await (await page.request.get(`${base}/api/v1/session`)).json();
  const csrf = session.csrf_token;
  // Ordinary Chinese user content is preserved; built-in labels are translated by identity.
  const person = await page.request.post(`${base}/api/v1/people`, { headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': randomUUID() }, data: { display_name: '音乐', notes: '中文备注' } });
  expect(person.status()).toBe(201);
  await page.getByRole('link', { name: 'People', exact: true }).click();
  await expect(page.getByText('音乐', { exact: true })).toBeVisible();
  await expect(page.getByText('中文备注', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Transcription preferences', exact: true }).click();
  await expect(page.getByText('Provider connections', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Language mode', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Jobs', exact: true }).click();
  await expect(page.getByText('No jobs yet', { exact: true })).toBeVisible();
  for (const name of ['Overview', 'System logs', 'Account management', 'Server settings']) {
    await page.getByRole('link', { name, exact: true }).click();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    const visible = await page.locator('main').innerText();
    expect(visible.replaceAll('中文用户名', '').replaceAll('简体中文', '')).not.toMatch(/[\u3400-\u9fff]/);
  }
  await page.route('**/api/v1/admin/server-settings', async route => {
    if (route.request().method() === 'PATCH') await route.abort('failed'); else await route.continue();
  });
  await page.getByLabel('Model name', { exact: true }).fill('local-model');
  await expect(page.getByTestId('settings-save-status')).toHaveText('Autosave failed; changes are not saved');
  await expect(page.locator('[data-slot=toast-description]').filter({ hasText: 'The connection was interrupted' })).toBeVisible();
  await page.locator('[data-slot=toast]').filter({ hasText: 'The connection was interrupted' }).locator('[data-slot=toast-close]').click();
  await page.unroute('**/api/v1/admin/server-settings');
  await page.getByRole('button', { name: 'Retry autosave', exact: true }).click();
  await expect(page.getByTestId('settings-save-status')).toHaveText('All changes saved');
  await page.getByLabel('LLM Base URL', { exact: true }).fill(process.env.VOICES_MODEL_TEST_URL);
  await expect(page.getByTestId('settings-save-status')).toHaveText('All changes saved');
  await page.getByRole('button', { name: 'Fetch LLM models', exact: true }).click();
  await expect(page.locator('[data-slot=toast-description]').filter({ hasText: 'The model service denied access' })).toBeVisible();
  await expect(page.getByText('private upstream response', { exact: true })).toHaveCount(0);
  await page.locator('[data-slot=toast]').filter({ hasText: 'The model service denied access' }).locator('[data-slot=toast-close]').click();
  // Use a real upload to cover English detail UI without any paid transcription call.
  const wav = Buffer.alloc(44 + 32000);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40);
  const uploaded = await page.request.post(`${base}/api/v1/recordings`, {
    headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': randomUUID() },
    multipart: { metadata: JSON.stringify({ title: '中文会议', auto_transcribe: false }), file: { name: 'meeting.wav', mimeType: 'audio/wav', buffer: wav } },
  });
  expect(uploaded.status()).toBe(201);
  const recording = (await uploaded.json()).recording;
  await page.goto(`${base}/recordings/${recording.id}`);
  await expect(page.getByRole('heading', { name: '中文会议', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Recording information', exact: true })).toBeVisible();
  await expect(page.getByText('No transcript yet', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/voices-language-detail-mobile.png', fullPage: true });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
    console.log(await page.evaluate(() => [...document.querySelectorAll('main *')].filter(node => node.getBoundingClientRect().right > innerWidth).map(node => ({ tag: node.tagName, class: node.className, text: node.textContent.slice(0, 100), right: node.getBoundingClientRect().right })).slice(0, 20)));
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('link', { name: 'My account', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/voices-language-mobile.png', fullPage: true });
  // Signing out restores the guest preference; a new account does not inherit the previous account's preference.
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Interface language', { exact: true })).toHaveValue('en');
  await page.getByRole('button', { name: 'Need an account? Register', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill('language-other@example.test');
  await page.getByLabel('Username', { exact: true }).fill('language_other');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Interface language', { exact: true }).selectOption('zh-CN');
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await page.getByRole('link', { name: '我的账号', exact: true }).click();
  await expect(page.getByLabel('界面语言', { exact: true })).toHaveValue('zh-CN');
  // A separate browser context has no guest cache and still adopts the saved account language.
  const fresh = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const next = await fresh.newPage(); watch(next);
  await next.goto(base);
  await expect(next.getByLabel('界面语言', { exact: true })).toHaveValue('zh-CN');
  await next.getByLabel('用户名或邮箱', { exact: true }).fill('language_admin');
  await next.getByLabel('密码', { exact: true }).fill(password);
  await next.getByRole('button', { name: '进入工作台', exact: true }).click();
  await expect(next.locator('html')).toHaveAttribute('lang', 'en');
  await expect(next.getByRole('link', { name: 'People', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  console.log('Interface language acceptance passed: guest/account isolation, persisted language, failed save, preserved draft DOM, English pages, Chinese content, mobile/dark, fresh browser login.');
} finally { await browser.close(); }
