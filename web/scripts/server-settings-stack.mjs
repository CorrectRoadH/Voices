// Real browser, application handlers and PostgreSQL; inject network delays/failures at the HTTP boundary.
import { chromium, expect } from '@playwright/test';
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
const base = process.env.VOICES_TEST_URL;
const errors = [];
try {
  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await adminContext.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await expect(page).toHaveTitle('Voices');
  await page.getByLabel('邮箱', { exact: true }).fill('server-admin@example.test');
  await page.getByLabel('用户名', { exact: true }).fill('ServerAdmin');
  await page.getByLabel('密码', { exact: true }).fill('test-browser-password');
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await page.getByRole('link', { name: '服务器设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '服务器设置', exact: true })).toBeVisible();
  await expect(page.getByLabel('站点 Base URL')).toHaveValue(base);
  await expect(page.getByRole('button', { name: '保存服务器配置', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重新加载已保存配置', exact: true })).toHaveCount(0);
  await page.getByLabel('Soniox API Key', { exact: true }).fill('browser-soniox-key');
  await page.getByLabel('AssemblyAI API Key', { exact: true }).fill('browser-assembly-key');
  await page.getByLabel('LLM Base URL', { exact: true }).fill('https://llm.example/v1');
  await page.getByLabel('模型名称', { exact: true }).fill('browser-model');
  await page.getByLabel('LLM API Key', { exact: true }).fill('browser-llm-key');
  await expect(page.getByTestId('settings-save-status')).toHaveText('所有修改已保存');
  await expect(page.getByText('已保存，等待重启生效', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Soniox API Key', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('LLM API Key', { exact: true })).toHaveValue('');
  await page.reload();
  await expect(page.getByLabel('模型名称')).toHaveValue('browser-model');
  // Editing an ordinary field while password inputs are blank retains secrets.
  await page.getByLabel('模型名称', { exact: true }).fill('browser-model-updated');
  await expect(page.getByTestId('settings-save-status')).toHaveText('所有修改已保存');
  await expect(page.getByRole('button', { name: '清除 LLM 密钥', exact: true })).toBeVisible();
  await page.getByLabel('模型名称', { exact: true }).fill('browser-model');
  await expect(page.getByTestId('settings-save-status')).toHaveText('所有修改已保存');
  // Explicit clearing is staged and can be cancelled before saving.
  await page.getByRole('button', { name: '清除 Soniox 密钥', exact: true }).click();
  await expect(page.getByLabel('Soniox API Key', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '取消清除 Soniox 密钥', exact: true }).click();
  await expect(page.getByLabel('Soniox API Key', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '清除 Soniox 密钥', exact: true }).click();
  await expect(page.getByTestId('settings-save-status')).toHaveText('所有修改已保存');
  await expect(page.getByRole('button', { name: '清除 Soniox 密钥', exact: true })).toHaveCount(0);
  // Delay a real response while another edit is made; the next revision must queue.
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const sent = new Promise((resolve) => { started = resolve; });
  await page.route('**/api/v1/admin/server-settings', async (route) => {
    if (route.request().method() === 'PATCH' && route.request().postDataJSON().llm_model === 'slow-model') {
      const response = await route.fetch();
      started();
      await gate;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await page.getByLabel('模型名称', { exact: true }).fill('slow-model');
  await sent;
  await expect(page.getByTestId('settings-save-status')).toHaveText('正在自动保存…');
  await page.getByLabel('模型名称', { exact: true }).fill('browser-model');
  await page.getByLabel('LLM API Key', { exact: true }).fill('browser-llm-key');
  release();
  await expect(page.getByTestId('settings-save-status')).toHaveText('所有修改已保存');
  await expect(page.getByLabel('模型名称', { exact: true })).toHaveValue('browser-model');
  await expect(page.getByLabel('LLM API Key', { exact: true })).toHaveValue('');
  await page.unroute('**/api/v1/admin/server-settings');
  // A transport failure keeps the draft and only an explicit retry sends it again.
  let failures = 0;
  await page.route('**/api/v1/admin/server-settings', async (route) => {
    if (route.request().method() === 'PATCH') { failures++; await route.abort('failed'); }
    else await route.continue();
  });
  await page.getByLabel('模型名称', { exact: true }).fill('retry-model');
  await expect(page.getByTestId('settings-save-status')).toHaveText('自动保存失败，修改尚未保存');
  await expect(page.locator('[data-slot=toast-description]').filter({ hasText: '网络连接中断或请求超时' })).toBeVisible();
  await page.locator('[data-slot=toast-close]').click();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(failures).toBe(1);
  await expect(page.getByLabel('模型名称', { exact: true })).toHaveValue('retry-model');
  await page.unroute('**/api/v1/admin/server-settings');
  await page.getByRole('button', { name: '重试自动保存', exact: true }).click();
  await expect(page.getByTestId('settings-save-status')).toHaveText('所有修改已保存');
  // A concurrent update yields a revision conflict, preserving the local draft.
  const snapshot = await (await page.request.get(`${base}/api/v1/admin/server-settings`)).json();
  const session = await (await page.request.get(`${base}/api/v1/session`)).json();
  const external = await page.request.patch(`${base}/api/v1/admin/server-settings`, {
    headers: { 'X-CSRF-Token': session.csrf_token }, data: { revision: snapshot.revision, llm_model: 'browser-model' },
  });
  expect(external.status()).toBe(200);
  await page.getByLabel('模型名称', { exact: true }).fill('conflicting-draft');
  await expect(page.locator('[data-slot=alert]').filter({ hasText: '配置已被其它页面修改' })).toBeVisible();
  await expect(page.locator('[data-slot=toast-description]').filter({ hasText: '配置已被其它页面修改' })).toBeVisible();
  await expect(page.getByLabel('模型名称', { exact: true })).toHaveValue('conflicting-draft');
  await page.reload();
  await expect(page.getByLabel('模型名称', { exact: true })).toHaveValue('browser-model');
  await page.screenshot({ path: process.env.VOICES_SETTINGS_SCREENSHOT, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('站点 Base URL')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Ordinary accounts have neither a navigation entry nor API read access.
  const userContext = await browser.newContext();
  const user = await userContext.newPage();
  await user.goto(base);
  await user.getByRole('button', { name: '没有账号？注册', exact: true }).click();
  await user.getByLabel('邮箱', { exact: true }).fill('server-user@example.test');
  await user.getByLabel('用户名', { exact: true }).fill('ServerUser');
  await user.getByLabel('密码', { exact: true }).fill('test-browser-password');
  await user.getByRole('button', { name: '创建账号', exact: true }).click();
  await expect(user.getByRole('heading', { name: '录音库', exact: true })).toBeVisible();
  await expect(user.getByRole('link', { name: '服务器设置', exact: true })).toHaveCount(0);
  const response = await user.request.get(`${base}/api/v1/admin/server-settings`);
  expect(response.status()).toBe(403);
  await user.goto(`${base}/admin/server`);
  await expect(user.getByRole('heading', { name: '录音库', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  console.log('Server settings browser acceptance passed: autosave, retain/clear secrets, reload, pending restart, mobile, ordinary-user denial.');
} finally {
  await browser.close();
}
