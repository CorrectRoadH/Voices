import { bindings, defineConfig } from "cf/config";
const release = process.env.SENTRY_RELEASE;
const validRelease = release && /^update@[a-f0-9]{40}$/.test(release) ? release : undefined;

export default defineConfig({
  worker: {
    name: "voices-update-worker",
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/index.ts",
    workersDev: true,
    domains: ["voices.niceeval.com"],
    env: {
      ...(validRelease ? { SENTRY_RELEASE: bindings.text(validRelease) } : {}),
      GITHUB_REPO: bindings.text("CorrectRoadH/Voices"),
      UPDATE_REQUESTS: bindings.analyticsEngineDataset({ name: "voices_update_requests" }),
    },
  },
});
