import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { fixture, login, logout, register } from "./support/session";

// @feature docs/feature/accounts/README.md
test("首位管理员、账号录音隔离、改密登录和关闭注册", async ({ app, agent, browser, screen }) => {
  await app.open();
  await expect(screen.getByText("创建管理员账号")).toBeVisible();
  await register(agent, "alice@example.test", "Alice", "123456", true);
  await expect(screen.getByRole("link", { name: "账号管理" })).toBeVisible();
  async function upload() {
    await agent.act("打开导入录音窗口，等待选择文件。");
    await screen.getByLabel("选择音频文件").setInputFiles(fixture("VOICES_TEST_AUDIO"));
    await agent.act("开始导入已选录音，等待回到录音库。");
    await expect(screen.getByRole("dialog", { name: "导入录音" })).toHaveCount(0);
    await expect(screen.getByText("accounts-meeting", { exact: true })).toBeVisible();
  }
  await upload();
  await logout(agent);
  await agent.act("切换到注册账号页面。");
  await register(agent, "bob@example.test", "Bob", "123456");
  await expect(screen.getByRole("link", { name: "账号管理" })).toHaveCount(0);
  await expect(screen.getByText("accounts-meeting", { exact: true })).toHaveCount(0);
  await upload();
  await agent.act(
    "在我的账号中把密码从 123456 改为 changed-browser-password，确认修改并退出登录。",
  );
  await login(agent, "BOB", "changed-browser-password");
  await expect(screen.getByRole("heading", { name: "我的账号" })).toBeVisible();
  await logout(agent);
  await login(agent, "alice@example.test", "123456");
  await agent.act("打开账号管理页面。");
  await expect(screen.getByText("bob@example.test")).toBeVisible();
  await agent.act("关闭允许创建新账号的开关。");
  await expect(screen.getByRole("switch", { name: "允许创建新账号" })).not.toBeChecked();
  await logout(agent);
  await expect(screen.getByText("注册已关闭，请使用已有账号登录。")).toBeVisible();
});
