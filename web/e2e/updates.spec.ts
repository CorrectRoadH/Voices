import { test, expect } from "@playwright/test";
const session = {
  authenticated: true,
  user: {
    id: "admin",
    email: "admin@example.test",
    display_name: "Admin",
    role: "admin",
    status: "active",
  },
  csrf_token: "csrf",
  public_base_url: "http://127.0.0.1:5187/voices/",
  restore_mode: false,
};
const empty = {
  current_version: "1.0.0",
  latest_version: null,
  update_available: false,
  status: "unchecked",
  checked_at: null,
  last_success_at: null,
  release_url: null,
  released_at: null,
  release_notes: "",
  announcements: [],
};
// @use-case docs/feature/updates/use-case/check-updates.md
for (const scenario of [
  { status: "disabled", label: "更新检查未启用", current: "1.0.0" },
  { status: "unchecked", label: "尚未检查", current: "1.0.0" },
  { status: "error", label: "检查失败，暂时无法确认最新版本", current: "1.0.0" },
  { status: "ok", label: "开发版本，不参与版本比较", current: "dev" },
  { status: "ok", label: "已是最新版", current: "1.0.0" },
]) {
  test(`updates ${scenario.status}/${scenario.current} is explicit`, async ({ page }) => {
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/session")) return route.fulfill({ json: session });
      if (path.endsWith("/admin/updates"))
        return route.fulfill({
          json: {
            ...empty,
            status: scenario.status,
            current_version: scenario.current,
            latest_version: scenario.status === "ok" ? "1.0.0" : null,
          },
        });
      if (path.endsWith("/admin/server-settings"))
        return route.fulfill({
          status: 503,
          json: { error: { message: "configuration unavailable" } },
        });
      return route.fulfill({ json: { items: [] } });
    });
    await page.goto("admin/server");
    const card = page.getByTestId("server-updates");
    await expect(card).toBeVisible();
    await expect(card.getByText(scenario.label, { exact: true })).toBeVisible();
    if (scenario.label !== "已是最新版")
      await expect(card.getByText("已是最新版", { exact: true })).toHaveCount(0);
    if (scenario.status === "disabled")
      await expect(card.getByRole("button", { name: "检查更新" })).toBeDisabled();
  });
}
