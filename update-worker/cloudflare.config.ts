import { bindings, defineConfig } from "cf/config";
export default defineConfig({
  worker: {
    name: "voices-update-worker",
    compatibilityDate: "2026-10-01",
    entrypoint: "src/index.ts",
    workersDev: true,
    domains: ["voices.niceeval.com"],
    env: {
      GITHUB_REPO: bindings.text("CorrectRoadH/Voices"),
      UPDATE_REQUESTS: bindings.analyticsEngineDataset({ name: "voices_update_requests" }),
    },
  },
});
