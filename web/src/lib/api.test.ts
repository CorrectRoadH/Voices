import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { configureSession, errorMessage, HttpError, request, write } from "./api";
import type { Session } from "./types";
afterEach(() => vi.unstubAllGlobals());
const session = {
  csrf_token: "test-csrf",
  public_base_url: "https://voices.example/voices/",
} as Session;
// @feature docs/feature/transcription/README.md
describe("真实 HTTP 客户端的故障边界", () => {
  it("同源写入带 CSRF 与调用者幂等键，前缀匹配部署配置", async () => {
    configureSession(session);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await write(
      "/recordings/r/transcriptions",
      "POST",
      { language_mode: "single" },
      "stable-idempotency-key",
    );
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/voices/api/v1/recordings/r/transcriptions");
    expect(options.credentials).toBe("same-origin");
    expect(options.headers.get("X-CSRF-Token")).toBe("test-csrf");
    expect(options.headers.get("Idempotency-Key")).toBe("stable-idempotency-key");
  });
  it("超时写入不自动重发付费操作，并提示先确认状态", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("network"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(write("/recordings/r/transcriptions", "POST", {})).rejects.toThrow("不要重复提交");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("409 不静默覆盖；HTML 错误不向页面泄露原始响应", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ error: { code: "conflict", message: "revision mismatch" } }),
            { status: 409 },
          ),
        )
        .mockResolvedValueOnce(new Response("<secret-provider-body>", { status: 502 })),
    );
    await expect(write("/segments/s", "PATCH", { revision: 1 })).rejects.toMatchObject({
      status: 409,
      code: "conflict",
    });
    expect(errorMessage(new HttpError(409, "conflict", "revision mismatch"))).toContain("不会覆盖");
    await expect(request("/jobs")).rejects.toMatchObject({
      status: 502,
      message: "服务器返回 502，请稍后重试。",
    });
  });
  it("401 触发重新鉴权，202 空响应被正确接受", async () => {
    const dispatch = vi.fn();
    vi.stubGlobal("window", { dispatchEvent: dispatch });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("{}", { status: 401 }))
        .mockResolvedValueOnce(new Response(null, { status: 202 })),
    );
    await expect(request("/recordings")).rejects.toBeInstanceOf(HttpError);
    expect(dispatch.mock.calls[0][0].type).toBe("voices:unauthorized");
    expect(await write("/jobs/j/retry", "POST", {})).toBeUndefined();
  });
  it("代理错误地返回 SPA HTML 时提供可诊断错误", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("<html>", { headers: { "Content-Type": "text/html" } })),
    );
    await expect(request("/session")).rejects.toThrow("API 代理配置");
  });
});

// @feature docs/feature/transcription/README.md
it("成功状态的损坏 JSON 不会泄露响应原文", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response("sensitive-provider-body", {
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  await expect(request("/providers")).rejects.toThrow("服务器返回的数据无法解析");
});

// @feature docs/feature/appearance/README.md
it("调用方取消信号不会关闭读取超时，超时后可以重新读取", async () => {
  const timeout = new AbortController();
  const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
  const caller = new AbortController();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        }),
    ),
  );
  const pending = request("/jobs", { signal: caller.signal });
  const assertion = expect(pending).rejects.toThrow("超时");
  timeout.abort(new DOMException("expired", "TimeoutError"));
  try {
    await assertion;
    expect(caller.signal.aborted).toBe(false);
  } finally {
    spy.mockRestore();
  }
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response('{"items":[]}', { headers: { "Content-Type": "application/json" } }),
      ),
  );
  await expect(request("/jobs", { signal: caller.signal })).resolves.toEqual({ items: [] });
});

// @feature docs/feature/appearance/README.md
it("主动取消保持取消原因且不重试", async () => {
  const caller = new AbortController();
  const fetchMock = vi.fn(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const pending = request("/jobs", { signal: caller.signal });
  const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  caller.abort();
  await assertion;
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
