import type { E2EConfig } from "e2e";
import base from "./e2e.config";
export default {
  ...base,
  tests: "tests/voiceprints.browser.ts",
  output: ".e2e/voiceprints",
} satisfies E2EConfig;
