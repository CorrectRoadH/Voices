import { cloudflare } from "@cloudflare/vite-plugin";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig(({ command, mode }) => {
  const upload = command === "build" && mode === "production" && !!process.env.SENTRY_AUTH_TOKEN;
  const release = process.env.SENTRY_RELEASE;
  if (upload && !/^update@[a-f0-9]{40}$/.test(release ?? "")) {
    throw new Error("Sentry upload requires SENTRY_RELEASE=update@<full-git-sha>");
  }
  return {
    lint: { options: { typeAware: true, typeCheck: true } },
    build: { sourcemap: true },
    plugins: [
      cloudflare(),
      sentryVitePlugin({
        org: "instaai",
        project: "voices-update",
        authToken: upload ? process.env.SENTRY_AUTH_TOKEN : undefined,
        telemetry: false,
        release: {
          name: release,
          inject: false,
          create: upload,
          finalize: upload,
          setCommits: false,
          deploy: false,
        },
        sourcemaps: {
          disable: upload ? false : "disable-upload",
          assets: ".cloudflare/output/v0/workers/default/bundle/**",
          ...(upload
            ? { filesToDeleteAfterUpload: ".cloudflare/output/v0/workers/default/bundle/**/*.map" }
            : {}),
        },
      }),
    ],
  };
});
