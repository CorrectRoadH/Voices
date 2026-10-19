// @concord-file
// @concord-implements docs/feature/recording-library/README.md
import { tr, interfaceLocale } from "@/lib/i18n";
import english from "@/locales/en.json";
import type { Session, Page, Schema } from "./types";
import { basePath } from "./links";
let prefix = basePath(import.meta.env.BASE_URL);
let csrf = "";
export function configureSession(session: Session) {
  csrf = session.csrf_token;
  prefix = basePath(session.public_base_url || import.meta.env.BASE_URL);
}
export function apiUrl(path: string) {
  return `${prefix}/api/v1${path}`;
}
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
  ) {
    super(message);
  }
}
export function errorMessage(error: unknown): string {
  if (error instanceof HttpError) {
    if (error.status === 409 && error.code === "conflict")
      return tr("内容已发生变化或请求冲突。请刷新最新内容后重新编辑，不会覆盖他人的修改。");
    if (error.status === 401) return tr("登录已过期，请重新登录后继续。");
    if (error.status === 403 && error.code === "csrf_rejected")
      return tr("请求未获授权，请刷新会话后重试。");
    if (error.status === 404) return tr("目标不存在、已删除或不属于当前录音。");
    const message = interfaceLocale() === "en"
      ? Object.hasOwn(english, error.message) ? tr(error.message) : `${tr("服务器拒绝请求。")} (${error.code})`
      : error.message;
    return `${message}${error.requestId ? tr("（请求 {{v0}}）", { v0: error.requestId }) : ""}`;
  }
  return error instanceof Error ? error.message : tr("操作失败，请稍后重试。");
}
function expired() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("voices:unauthorized"));
}
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  if (init.method && !["GET", "HEAD"].includes(init.method)) headers.set("X-CSRF-Token", csrf);
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      headers,
      credentials: "same-origin",
      signal: init.signal ?? AbortSignal.timeout(30000),
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new Error(
      init.method && !["GET", "HEAD"].includes(init.method)
        ? tr("网络连接中断或请求超时。写入结果可能已保存，请先刷新确认；不要重复提交转写任务。")
        : tr("无法连接服务器或请求超时，请检查网络后重新加载。"),
    );
  }
  if (!response.ok) {
    if (response.status === 401 && path !== "/session") expired();
    let body: { error?: { code?: string; message?: string; request_id?: string } } = {};
    try {
      body = await response.json();
    } catch {
      /* HTML proxy errors are never shown as provider output. */
    }
    throw new HttpError(
      response.status,
      body.error?.code || "http_error",
      body.error?.message || tr("服务器返回 {{v0}}，请稍后重试。", { v0: response.status }),
      body.error?.request_id,
    );
  }
  if (
    response.status === 204 ||
    (response.status === 202 && !response.headers.get("content-type")?.includes("application/json"))
  )
    return undefined as T;
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error(tr("服务器未返回预期的 JSON 响应，请检查 API 代理配置。"));
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(tr("服务器返回的数据无法解析，请刷新后重试。"));
  }
}
export function write<T>(path: string, method: string, body?: unknown, key?: string) {
  return request<T>(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: key ? { "Idempotency-Key": key } : undefined,
  });
}
export function query(params: Record<string, string | number | boolean | null | undefined>) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== "" && value != null) search.set(key, String(value));
  });
  return search.size ? `?${search}` : "";
}
export type UploadMetadata = Schema["ImportMetadata"];
export function upload(
  file: File,
  metadata: UploadMetadata,
  key: string,
  progress: (percent: number) => void,
  signal?: AbortSignal,
) {
  return new Promise<Schema["RecordingCreated"]>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const finish = () => signal?.removeEventListener("abort", abort);
    xhr.open("POST", apiUrl("/recordings"));
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-CSRF-Token", csrf);
    xhr.setRequestHeader("Idempotency-Key", key);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) progress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      finish();
      if (xhr.status === 401) expired();
      let body;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        reject(new Error(tr("上传响应无法读取，请刷新确认是否已导入。")));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body);
        return;
      }
      reject(
        new HttpError(
          xhr.status,
          body.error?.code || "upload_failed",
          body.error?.message || tr("上传失败，请刷新确认结果。"),
          body.error?.request_id,
        ),
      );
    };
    xhr.onerror = () => {
      finish();
      reject(new Error(tr("上传连接中断。可使用同一导入选项重传，服务端会按内容去重。")));
    };
    xhr.onabort = () => {
      finish();
      reject(new Error(tr("上传已中止；服务器可能已接收，请刷新确认。")));
    };
    if (signal?.aborted) {
      reject(new Error(tr("上传已中止")));
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    const data = new FormData();
    data.append("metadata", JSON.stringify(metadata));
    data.append("file", file);
    xhr.send(data);
  });
}
export async function downloadExport(transcriptionId: string, format: string) {
  const response = await fetch(
    apiUrl(`/transcriptions/${encodeURIComponent(transcriptionId)}/export?format=${format}`),
    { credentials: "same-origin", signal: AbortSignal.timeout(30000) },
  );
  if (!response.ok) {
    if (response.status === 401) expired();
    throw new HttpError(
      response.status,
      "export_failed",
      response.status === 422
        ? tr("该版本含无时间片段，无法导出 SRT；请选择 TXT 或 JSON。")
        : tr("导出失败，请稍后重试。"),
    );
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `voices-${transcriptionId}.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function requestAll<T>(path: string, signal?: AbortSignal): Promise<Page<T>> {
  const items: T[] = [];
  const seen = new Set<string>();
  let next = path;
  while (true) {
    const page = await request<Page<T>>(next, { signal });
    items.push(...page.items);
    if (!page.next_cursor) return { items, next_cursor: null };
    if (seen.has(page.next_cursor)) throw new Error(tr("服务器返回重复分页游标，请刷新后重试。"));
    seen.add(page.next_cursor);
    const url = new URL(path, "http://local");
    url.searchParams.set("cursor", page.next_cursor);
    next = url.pathname + url.search;
  }
}
