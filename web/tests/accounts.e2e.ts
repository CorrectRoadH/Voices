import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { fixture, login, logout, register } from "./support/session";

// @feature docs/feature/accounts/README.md
test("首位管理员、账号录音隔离、改密登录和关闭注册", async ({ app, browser, screen }) => {
  await app.open();
  await expect(screen.getByText("创建管理员账号")).toBeVisible();
  await register(screen, "alice@example.test", "Alice", "123456", true);
  await expect(screen.getByRole("link", { name: "账号管理" })).toBeVisible();
  async function upload() {
    await screen.getByRole("button", { name: "导入录音" }).first().click();
    await screen.getByLabel("选择音频文件").setInputFiles(fixture("VOICES_TEST_AUDIO"));
    await screen.getByRole("button", { name: /开始导入/ }).click();
    await expect(screen.getByRole("dialog", { name: "导入录音" })).toHaveCount(0);
    await expect(screen.getByText("accounts-meeting", { exact: true })).toBeVisible();
  }
  await upload();
  await logout(browser);
  await screen.getByRole("button", { name: "没有账号？注册" }).click();
  await register(screen, "bob@example.test", "Bob", "123456");
  await expect(screen.getByRole("link", { name: "账号管理" })).toHaveCount(0);
  await expect(screen.getByText("accounts-meeting", { exact: true })).toHaveCount(0);
  await upload();
  await screen.getByRole("link", { name: "我的账号" }).click();
  await screen.getByLabel("当前密码").fill("123456");
  await screen.getByLabel("新密码").fill("changed-browser-password");
  await screen.getByLabel("确认新密码").fill("changed-browser-password");
  await screen.getByRole("button", { name: "修改密码并退出" }).click();
  await login(screen, "BOB", "changed-browser-password");
  await expect(screen.getByRole("heading", { name: "我的账号" })).toBeVisible();
  await logout(browser);
  await login(screen, "alice@example.test", "123456");
  await screen.getByRole("link", { name: "账号管理" }).click();
  await expect(screen.getByText("bob@example.test")).toBeVisible();
  await screen.getByRole("switch", { name: "允许创建新账号" }).uncheck();
  await expect(screen.getByRole("switch", { name: "允许创建新账号" })).not.toBeChecked();
  await screen.getByRole("button", { name: "退出登录" }).click();
  await expect(screen.getByText("注册已关闭，请使用已有账号登录。")).toBeVisible();
});
