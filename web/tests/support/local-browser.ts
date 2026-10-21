import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserProvider } from "@e2e-dev/web";

// 系统 Chromium 用于 Nix 等无法运行官方浏览器二进制的环境。
export function localBrowser(executable: string): BrowserProvider {
  const processes = new Map<string, ChildProcess>();
  async function close(id: string) {
    const child = processes.get(id);
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => child.kill("SIGKILL"), 3000);
        child.once("exit", () => {
          clearTimeout(force);
          resolve();
        });
        child.kill("SIGTERM");
      });
    }
    await rm(id, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    processes.delete(id);
  }
  return {
    name: "系统 Chromium",
    async acquire({ signal }) {
      const id = await mkdtemp(join(tmpdir(), "voices-e2e-chromium-"));
      const child = spawn(
        executable,
        [
          "--headless",
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--remote-debugging-address=127.0.0.1",
          "--remote-debugging-port=0",
          `--user-data-dir=${id}`,
          "about:blank",
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      processes.set(id, child);
      try {
        const cdpEndpoint = await new Promise<string>((resolve, reject) => {
          let output = "";
          const abort = () => reject(new Error("浏览器启动已取消"));
          const timer = setTimeout(() => reject(new Error("浏览器启动超时")), 15000);
          const cleanup = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
          };
          signal.addEventListener("abort", abort, { once: true });
          child.once("error", (error) => {
            cleanup();
            reject(error);
          });
          child.once("exit", () => {
            cleanup();
            reject(new Error("浏览器在连接前退出"));
          });
          child.stderr!.on("data", (chunk: Buffer) => {
            output = (output + chunk.toString()).slice(-8192);
            const endpoint = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
            if (endpoint) {
              cleanup();
              resolve(endpoint);
            }
          });
          if (signal.aborted) {
            cleanup();
            abort();
          }
        });
        return { id, cdpEndpoint };
      } catch (error) {
        await close(id);
        throw error;
      }
    },
    async release(lease) {
      await close(lease.id);
    },
    async sweep() {
      const ids = [...processes.keys()];
      await Promise.all(ids.map(close));
      return ids;
    },
  };
}
