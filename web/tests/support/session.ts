import { randomUUID } from "node:crypto";
import type { Browser } from "@e2e-dev/web";
import type { Agent } from "e2e";
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

export async function login(agent: Agent, user: string, password: string) {
  await agent.act("使用账号 {user}、密码 {password} 登录。", { params: { user, password } });
}

export async function logout(agent: Agent) {
  await agent.act("退出当前账号，停在登录或注册页面。");
}

export async function register(
  agent: Agent,
  email: string,
  username: string,
  password: string,
  first = false,
) {
  await agent.act("注册账号：邮箱 {email}、用户名 {username}、密码 {password}。", {
    params: { email, username, password },
  });
  if (first) await agent.act("选择暂不启用 LLM，完成初始化并进入录音库。");
}

export async function noOverflow(browser: Browser) {
  expect(
    await browser.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "窄屏不应横向溢出",
  ).toBe(true);
}
