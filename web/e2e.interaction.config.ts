import type { E2EConfig } from "e2e";
import process from "node:process";
import { web } from "@e2e-dev/web";
import { localBrowser } from "./tests/support/local-browser";

// Keyboard, network timing and concurrency checks use precise browser operations;
// no model or paid service is configured for this suite.
export default {
  tests: "tests/interaction.browser.ts",
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
      app: { url: process.env.VOICES_TEST_URL },
    },
  ],
  workers: 1,
  retries: 0,
  timeout: 120000,
  assertionTimeout: 15000,
  trace: "retain-on-failure",
  reporters: ["list", "markdown"],
  output: ".e2e/interaction",
} satisfies E2EConfig;
