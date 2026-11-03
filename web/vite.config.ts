import { defineConfig, loadEnv } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
export default defineConfig(({ mode }) => {
  const envDir = fileURLToPath(new URL("..", import.meta.url));
  const env = loadEnv(mode, envDir, "");
  const pathname = new URL(env.PUBLIC_BASE_URL || "/", "http://localhost").pathname;
  const base = `${pathname.replace(/\/$/, "")}/`;
  // Vite+ input globs cannot reach outside this separate installation root.
  // Include parent environment files in the task key without logging their contents.
  const buildEnvHash = createHash("sha256");
  for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    const path = new URL(`../${name}`, import.meta.url);
    buildEnvHash.update(name);
    buildEnvHash.update(existsSync(path) ? readFileSync(path) : "missing");
  }
  return {
    run: {
      tasks: {
        build: {
          command: `VOICES_BUILD_ENV_HASH=${buildEnvHash.digest("hex")} vp build`,
          dependsOn: ["typecheck"],
          cache: {
            env: ["PUBLIC_BASE_URL", "NODE_ENV"],
            input: [
              { auto: true },
              "src/**",
              "public/**",
              "index.html",
              "package.json",
              "pnpm-lock.yaml",
              "pnpm-workspace.yaml",
              "vite.config.ts",
              "tsconfig*.json",
              "tests/**",
              "scripts/**",
            ],
            output: ["dist/**"],
          },
        },
        typecheck: {
          command:
            "sh -c 'vp run check:i18n && vp exec tsc --noEmit && vp exec tsc -p tsconfig.e2e.json'",
          cache: {
            input: [
              "src/**",
              "tests/**",
              "scripts/**",
              "*.ts",
              "tsconfig*.json",
              "package.json",
              "pnpm-lock.yaml",
              "pnpm-workspace.yaml",
            ],
            output: [],
          },
        },
      },
    },
    lint: { options: { typeAware: true, typeCheck: true } },
    fmt: { ignorePatterns: ["src/lib/api.generated.ts"] },
    base,
    envDir,
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": { target: "http://localhost:18080", changeOrigin: true },
        ...(base === "/"
          ? {}
          : { [`${base}api`]: { target: "http://localhost:18080", changeOrigin: true } }),
      },
    },
    test: { include: ["src/**/*.test.ts"], environment: "node" },
  };
});
