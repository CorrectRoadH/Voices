import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";
import { createOpenAI } from "@ai-sdk/openai";
import dotenv from "dotenv";
import { localBrowser } from "./tests/support/local-browser";

dotenv.config({ path: "../.env", quiet: true });
function modelSetting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`请在根目录 .env 或进程环境中配置 ${name}`);
  return value;
}
const model = createOpenAI({
  apiKey: modelSetting("E2E_MODEL_API_KEY"),
  baseURL: modelSetting("E2E_MODEL_BASE_URL"),
}).responses(modelSetting("E2E_MODEL"));

const url = process.env.VOICES_TEST_URL;
if (!url) throw new Error("请通过 vp run test:e2e 启动隔离的 Go/PostgreSQL fixture");
export default {
  tests: "tests/*.e2e.ts",
  agents: { default: { model, maxModelCalls: 12, maxSteps: 20 } },
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
  timeout: 420000,
  assertionTimeout: 15000,
  trace: "retain-on-failure",
  reporters: ["list", "markdown"],
  output: process.env.VOICES_E2E_OUTPUT || ".e2e",
} satisfies E2EConfig;
