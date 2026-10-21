import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";
import { localBrowser } from "./tests/support/local-browser";

const url = process.env.VOICES_TEST_URL;
if (!url) throw new Error("请通过 pnpm test:e2e 启动隔离的 Go/PostgreSQL fixture");
export default {
  tests: "tests/*.e2e.ts",
  targets: [
    {
      name: "chromium",
      engine: web({
        browser: process.env.E2E_CHROMIUM_EXECUTABLE_PATH
          ? localBrowser(process.env.E2E_CHROMIUM_EXECUTABLE_PATH)
          : "chromium",
        viewport: { width: 1440, height: 1000 },
        timezoneId: "Asia/Taipei",
      }),
      app: { url },
    },
  ],
  workers: 1,
  retries: 0,
  timeout: 90000,
  assertionTimeout: 15000,
  trace: "retain-on-failure",
  reporters: ["list", "markdown"],
  output: process.env.VOICES_E2E_OUTPUT || ".e2e",
} satisfies E2EConfig;
