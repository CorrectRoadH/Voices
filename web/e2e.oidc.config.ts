import type { E2EConfig } from "e2e";
import base from "./e2e.config";

export default {
  ...base,
  tests: "tests/oidc.browser.ts",
  output: ".e2e/oidc",
} satisfies E2EConfig;
