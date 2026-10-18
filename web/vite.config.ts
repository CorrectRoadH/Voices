import { defineConfig, loadEnv } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
export default defineConfig(({ mode }) => {
  const envDir = fileURLToPath(new URL("..", import.meta.url));
  const env = loadEnv(mode, envDir, "");
  const pathname = new URL(env.PUBLIC_BASE_URL || "/", "http://localhost").pathname;
  const base = `${pathname.replace(/\/$/, "")}/`;
  return {
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
