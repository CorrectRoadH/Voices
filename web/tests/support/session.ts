import { randomUUID } from "node:crypto";
import type { Browser } from "@e2e-dev/web";
import type { Screen } from "e2e";
import { expect } from "e2e";

export function fixture(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少测试 fixture：${name}`);
  return value;
}

// 使用当前浏览器会话访问真实接口，供并发修改和服务器结果校验使用。
export async function api(browser: Browser, path: string, method = "GET", data?: unknown) {
  const cookies = await browser.cookies();
  const headers: Record<string, string> = {
    Cookie: cookies.map(({ name, value }) => `${name}=${value}`).join("; "),
    Origin: fixture("VOICES_TEST_URL"),
    "X-CSRF-Token": cookies.find(({ name }) => name === "voices_csrf")?.value || "",
  };
  if (method === "POST") headers["Idempotency-Key"] = randomUUID();
  if (data !== undefined && !(data instanceof FormData))
    headers["Content-Type"] = "application/json";
  return fetch(fixture("VOICES_TEST_URL") + "/api/v1" + path, {
    method,
    headers,
    body: data === undefined ? undefined : data instanceof FormData ? data : JSON.stringify(data),
    signal: AbortSignal.timeout(10000),
  });
}

export async function login(screen: Screen, user: string, password: string) {
  await screen.getByLabel(/^(用户名或邮箱|邮箱)$/).fill(user);
  await screen.getByLabel("密码").fill(password);
  await screen.getByRole("button", { name: "进入工作台" }).click();
}

export async function logout(browser: Browser) {
  expect((await api(browser, "/session", "DELETE")).status, "退出会话应成功").toBe(204);
  await browser.goto(fixture("VOICES_TEST_URL"));
}

export async function register(
  screen: Screen,
  email: string,
  username: string,
  password: string,
  first = false,
) {
  await screen.getByLabel("邮箱").fill(email);
  await screen.getByLabel("用户名").fill(username);
  await screen.getByLabel("密码").fill(password);
  await screen.getByRole("button", { name: "创建账号" }).click();
  if (first) await screen.getByRole("button", { name: "暂不启用 LLM", exact: true }).click();
  await expect(screen.getByRole("heading", { name: "录音库" })).toBeVisible();
}

export async function noOverflow(browser: Browser) {
  expect(
    await browser.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "窄屏不应横向溢出",
  ).toBe(true);
}
