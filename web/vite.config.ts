import { defineConfig, loadEnv } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
export default defineConfig(({ mode }) => {
  const envDir = fileURLToPath(new URL("..", import.meta.url));
  const env = loadEnv(mode, envDir, "");
  const pathname = new URL(env.PUBLIC_BASE_URL || "/", "http://localhost").pathname;
  const base = `${pathname.replace(/\/$/, "")}/`;
  // Vite+ input globs cannot reach outside this separate installation root.
  // Include parent environment files in the task key without logging their contents.
  const buildEnvHash = createHash("sha256");
  for (const entry of readdirSync(envDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (
      (entry.isFile() || entry.isSymbolicLink()) &&
      (entry.name === ".env" || entry.name.startsWith(".env."))
    ) {
      const path = join(envDir, entry.name);
      if (!statSync(path, { throwIfNoEntry: false })?.isFile()) continue;
      buildEnvHash.update(JSON.stringify([entry.name, readFileSync(path, "utf8")]));
    }
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
