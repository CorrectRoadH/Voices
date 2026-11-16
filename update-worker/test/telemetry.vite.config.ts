import { defineConfig } from "vite-plus";
export default defineConfig({
  build: {
    outDir: ".cloudflare/test-telemetry",
    lib: { entry: "test/telemetry.fixture.ts", formats: ["es"], fileName: () => "index.js" },
    rollupOptions: { external: [/^node:/, /^cloudflare:/] },
  },
});
