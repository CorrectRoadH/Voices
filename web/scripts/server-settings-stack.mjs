// Real browser, application handlers and PostgreSQL; no route mocks.
import { chromium, expect } from '@playwright/test';
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
const base = process.env.VOICES_TEST_URL;
const errors = [];
try {
  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await adminContext.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.getByLabel('邮箱', { exact: true }).fill('server-admin@example.test');
  await page.getByLabel('用户名', { exact: true }).fill('ServerAdmin');
  await page.getByLabel('密码', { exact: true }).fill('test-browser-password');
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await page.getByRole('link', { name: '服务器设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '服务器设置', exact: true })).toBeVisible();
  await expect(page.getByLabel('站点 Base URL')).toHaveValue(base);
  await page.getByLabel('Soniox API Key', { exact: true }).fill('browser-soniox-key');
  await page.getByLabel('AssemblyAI API Key', { exact: true }).fill('browser-assembly-key');
  await page.getByLabel('LLM Base URL', { exact: true }).fill('https://llm.example/v1');
  await page.getByLabel('模型名称', { exact: true }).fill('browser-model');
  await page.getByLabel('LLM API Key', { exact: true }).fill('browser-llm-key');
  await page.getByRole('button', { name: '保存服务器配置', exact: true }).click();
  await expect(page.getByText('已保存，等待重启生效', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Soniox API Key', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('LLM API Key', { exact: true })).toHaveValue('');
  await page.reload();
  await expect(page.getByLabel('模型名称')).toHaveValue('browser-model');
  // An ordinary save with blank password inputs must retain secrets.
  await page.getByRole('button', { name: '保存服务器配置', exact: true }).click();
  await expect(page.getByRole('button', { name: '清除 LLM 密钥', exact: true })).toBeVisible();
  // Explicit clearing is staged and can be cancelled before saving.
  await page.getByRole('button', { name: '清除 Soniox 密钥', exact: true }).click();
  await expect(page.getByLabel('Soniox API Key', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '取消清除 Soniox 密钥', exact: true }).click();
  await expect(page.getByLabel('Soniox API Key', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '清除 Soniox 密钥', exact: true }).click();
  await page.getByRole('button', { name: '保存服务器配置', exact: true }).click();
  await expect(page.getByRole('button', { name: '清除 Soniox 密钥', exact: true })).toHaveCount(0);
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
  console.log('Server settings browser acceptance passed: save, retain/clear secrets, reload, pending restart, mobile, ordinary-user denial.');
} finally {
  await browser.close();
}
