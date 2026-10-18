import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5187/voices/",
    headless: true,
    timezoneId: "Asia/Taipei",
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm dev --port 5187",
    url: "http://127.0.0.1:5187/voices/",
    env: { PUBLIC_BASE_URL: "/voices/" },
    reuseExistingServer: false,
    timeout: 30000,
  },
});
