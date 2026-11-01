// @concord-file
// @concord-implements docs/feature/call-logs/README.md
// @concord-implements docs/feature/call-logs/use-case/inspect-calls.md
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Copy, RefreshCw } from "lucide-react";
import { tr } from "@/lib/i18n";
import { request, errorMessage } from "@/lib/api";
import { date } from "@/lib/format";
import type { Schema } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { useAction } from "@/lib/hooks";
import { copyText } from "@/lib/links";
import { Badge } from "@/components/ui/badge";
import { PageHeading, ErrorBox, Loading, EmptyState } from "@/components/shared";

type Call = Schema["ExternalCall"];
const operations: Record<string, string> = {
  upload: "上传音频",
  submit: "提交转写",
  poll: "查询进度",
  fetch_result: "获取结果",
  delete_file: "删除远端音频",
  delete_transcription: "删除远端转写",
  generate_insights: "生成摘要与章节",
  list_models: "获取模型列表",
  test_model: "测试模型",
};
const states: Record<string, string> = {
  running: "调用中",
  succeeded: "调用成功",
  failed: "调用失败",
  uncertain: "结果待确认",
  interrupted: "调用中断",
};
const filterKeys = [
  "category",
  "operation",
  "provider",
  "state",
  "model",
  "job_id",
  "recording_id",
  "transcription_id",
  "generation",
  "from",
  "to",
];
export function CallLogs({ admin = false }: { admin?: boolean }) {
  const [params, setParams] = useSearchParams();
  const [names, setNames] = useState<Record<string, string>>({});
  const [items, setItems] = useState<Call[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pending, setPending] = useState<"refresh" | "page" | null>("refresh");
  const loading = pending !== null;
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const requestVersion = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const loadedScope = useRef("");
  const query = new URLSearchParams();
  for (const key of [...filterKeys, ...(admin ? ["account", "owner_id"] : [])]) {
    const value = params.get(key);
    if (value) query.set(key, value);
  }
  const filter = query.toString();
  const endpoint = admin ? "/admin/calls" : "/calls";
  async function load(more = false) {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const version = ++requestVersion.current;
    setPending(more ? "page" : "refresh");
    setError("");
    const scope = `${endpoint}?${filter}`;
    if (loadedScope.current !== scope) {
      setItems([]);
      setCursor(null);
    }
    loadedScope.current = scope;
    const q = new URLSearchParams(filter);
    if (more && cursor) q.set("cursor", cursor);
    try {
      const page = await request<Schema["ExternalCallList"]>(`${endpoint}?${q}`, {
        signal: abort.signal,
      });
      if (version !== requestVersion.current) return;
      setItems((old) =>
        more
          ? [
              ...old,
              ...page.items.filter((item) => !old.some((previous) => previous.id === item.id)),
            ]
          : page.items,
      );
      setCursor(page.next_cursor);
    } catch (e) {
      if (!abort.signal.aborted && version === requestVersion.current) setError(errorMessage(e));
    } finally {
      if (version === requestVersion.current) setPending(null);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      controller.current?.abort();
      requestVersion.current++;
    };
  }, [filter, endpoint, revision]);
  const recordingIds = [
    ...new Set(
      items.filter((c) => c.can_open_recording && c.recording_id).map((c) => c.recording_id!),
    ),
  ]
    .sort()
    .join(",");
  const nameCache = useRef<{ endpoint: string; revision: number; values: Map<string, string> }>({
    endpoint,
    revision,
    values: new Map(),
  });
  useEffect(() => {
    const abort = new AbortController();
    if (nameCache.current.endpoint !== endpoint || nameCache.current.revision !== revision) {
      nameCache.current = { endpoint, revision, values: new Map() };
      setNames({});
    }
    const cache = nameCache.current.values;
    const missing = recordingIds.split(",").filter((id) => id && !cache.has(id));
    async function worker() {
      while (missing.length && !abort.signal.aborted) {
        const id = missing.shift()!;
        try {
          const recording = await request<Schema["Recording"]>(`/recordings/${id}`, {
            signal: abort.signal,
          });
          if (abort.signal.aborted) return;
          cache.set(id, recording.title);
        } catch {
          if (abort.signal.aborted) return;
          // Do not retain an outdated title after access is lost; retry on the next refresh.
          cache.set(id, "");
        }
        while (cache.size > 500) cache.delete(cache.keys().next().value!);
        setNames(Object.fromEntries(cache));
      }
    }
    void Promise.all(Array.from({ length: Math.min(4, missing.length) }, () => worker()));
    return () => abort.abort();
  }, [recordingIds, endpoint, revision]);
  function change(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }
  function select(key: string, label: string, options: Record<string, string>) {
    return (
      <Field key={key} className="min-w-0">
        <FieldLabel htmlFor={`call-${key}`}>{tr(label)}</FieldLabel>
        <NativeSelect
          id={`call-${key}`}
          value={params.get(key) || ""}
          onChange={(e) => change(key, e.target.value)}
        >
          <NativeSelectOption value="">{tr("全部")}</NativeSelectOption>
          {Object.entries(options).map(([value, title]) => (
            <NativeSelectOption key={value} value={value}>
              {tr(title)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
    );
  }
  return (
    <>
      <PageHeading
        title={tr("调用日志")}
        description={tr(
          admin
            ? "查看全站 STT 与 AI 调用，调用记录永久保存。"
            : "查看自己的 STT 与 AI 调用，调用记录永久保存。",
        )}
      >
        <Button
          variant="outline"
          loading={pending === "refresh"}
          disabled={loading}
          onClick={() => setRevision((n) => n + 1)}
        >
          <RefreshCw data-icon="inline-start" />
          {tr("刷新")}
        </Button>
      </PageHeading>
      <section className="mb-6 flex flex-col gap-4" aria-label={tr("筛选调用记录")}>
        <FieldGroup className="grid gap-x-4 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
          {select("category", "调用类别", { stt: "STT", ai: "AI" })}
          {select("state", "调用结果", states)}
          {select("operation", "调用操作", operations)}
          {select("provider", "服务商", {
            soniox: "Soniox",
            assemblyai: "AssemblyAI",
            openai_compatible: "OpenAI Compatible",
          })}
          <Field className="min-w-0">
            <FieldLabel htmlFor="call-model">{tr("模型 ID")}</FieldLabel>
            <Input
              id="call-model"
              value={params.get("model") || ""}
              onChange={(e) => change("model", e.target.value)}
              maxLength={200}
            />
          </Field>
          {admin && (
            <Field className="min-w-0">
              <FieldLabel htmlFor="call-account">{tr("账号搜索")}</FieldLabel>
              <Input
                id="call-account"
                value={params.get("account") || ""}
                onChange={(e) => change("account", e.target.value)}
                maxLength={200}
              />
            </Field>
          )}
          {["from", "to"].map((key) => (
            <Field key={key} className="min-w-0">
              <FieldLabel htmlFor={`call-${key}`}>
                {tr(key === "from" ? "开始时间" : "结束时间")}
              </FieldLabel>
              <Input
                id={`call-${key}`}
                type="datetime-local"
                value={localDate(params.get(key))}
                onChange={(e) =>
                  change(key, e.target.value ? new Date(e.target.value).toISOString() : "")
                }
              />
            </Field>
          ))}
        </FieldGroup>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {tr(
            "调用成功不代表任务完成；音频时长和 token 用量不是费用账单。未返回的用量显示为未知。",
          )}
        </p>
        {filter && (
          <Button
            className="self-start"
            variant="ghost"
            size="sm"
            onClick={() => {
              const next = new URLSearchParams(params);
              for (const key of [...filterKeys, "account", "owner_id"]) next.delete(key);
              setParams(next, { replace: true });
            }}
          >
            {tr("清除筛选")}
          </Button>
        )}
      </section>
      {filterKeys
        .filter((k) => k.endsWith("_id") || k === "generation")
        .filter((k) => params.has(k))
        .map((k) => (
          <p key={k} className="mb-2 break-all text-sm">
            {k}: {params.get(k)}{" "}
            <Button size="sm" variant="ghost" onClick={() => change(k, "")}>
              {tr("清除筛选")}
            </Button>
          </p>
        ))}
      <ErrorBox message={error} retry={() => void load()} />
      {loading && !items.length ? (
        <Loading />
      ) : !items.length && !error ? (
        <EmptyState
          title={filter ? tr("没有匹配的调用记录") : tr("暂无调用记录")}
          description={
            filter
              ? tr("请调整或清除筛选。")
              : tr("发起 STT 或 AI 操作后会在这里显示，启用前的历史不会补录。")
          }
        />
      ) : (
        <section className="flex flex-col gap-3" aria-label={tr("调用记录")}>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium">{tr("调用记录")}</h2>
            <p className="text-xs tabular-nums text-muted-foreground">
              {tr("已加载")} {items.length} {tr("次")}
            </p>
          </div>
          <div className="divide-y overflow-hidden rounded-xl border bg-card">
            {items.map((call) => (
              <CallRow
                key={call.id}
                call={call}
                admin={admin}
                name={names[call.recording_id || ""]}
              />
            ))}
          </div>
        </section>
      )}
      {cursor && (
        <Button
          className="mt-4"
          variant="outline"
          loading={pending === "page"}
          disabled={loading}
          onClick={() => void load(true)}
        >
          {tr(pending === "page" ? "加载中…" : "加载更多")}
        </Button>
      )}
    </>
  );
}
function localDate(value: string | null) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function audioTime(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
function CallRow({ call, admin, name }: { call: Call; admin: boolean; name?: string }) {
  const action = useAction();
  const metric = (value: number | null) => (value === null ? tr("未知") : value.toLocaleString());
  const identifiers = {
    id: "调用 ID",
    job_id: "任务 ID",
    recording_id: "录音 ID",
    transcription_id: "转写 ID",
    operation_id: "操作 ID",
    generation: "生成 ID",
  } as const;
  const provider =
    {
      soniox: "Soniox",
      assemblyai: "AssemblyAI",
      openai_compatible: "OpenAI Compatible",
    }[call.provider] || call.provider;
  return (
    <article className="flex min-w-0 flex-col gap-4 p-4 text-sm sm:p-5">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">{tr(operations[call.operation] || call.operation)}</h3>
            <Badge
              variant={
                call.state === "failed"
                  ? "destructive"
                  : call.state === "succeeded"
                    ? "outline"
                    : "secondary"
              }
            >
              {tr(states[call.state] || call.state)}
            </Badge>
          </div>
          {call.can_open_recording && call.recording_id && (
            <Link
              className="w-fit max-w-full break-words text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
              to={`/recordings/${call.recording_id}`}
            >
              {name || tr("查看录音")}
            </Link>
          )}
        </div>
        <time
          dateTime={call.started_at}
          className="shrink-0 text-xs tabular-nums text-muted-foreground"
        >
          {date(call.started_at)}
        </time>
      </header>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 xl:grid-cols-4">
        <div className="min-w-0">
          <dt className="mb-1 text-xs text-muted-foreground">{tr("服务商 / 模型")}</dt>
          <dd className="break-all">{provider}</dd>
          <dd className="break-all text-xs text-muted-foreground">{call.model || tr("未知")}</dd>
        </div>
        <div className="min-w-0">
          <dt className="mb-1 text-xs text-muted-foreground">{tr("请求状态")}</dt>
          <dd className="tabular-nums">HTTP: {metric(call.http_status)}</dd>
          <dd className="text-xs text-muted-foreground">
            {tr("请求已发起")}:{" "}
            {tr(call.request_started === null ? "未知" : call.request_started ? "是" : "否")}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="mb-1 text-xs text-muted-foreground">{tr("耗时")}</dt>
          <dd className="tabular-nums">
            {call.duration_ms === null ? tr("未知") : `${(call.duration_ms / 1000).toFixed(2)} s`}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="mb-1 text-xs text-muted-foreground">
            {tr(call.category === "ai" ? "输入 / 输出 / 总 token" : "音频时长")}
          </dt>
          <dd className="break-words tabular-nums">
            {call.category === "ai"
              ? `${metric(call.input_tokens)} / ${metric(call.output_tokens)} / ${metric(call.total_tokens)}`
              : call.audio_duration_ms === null
                ? tr("未知")
                : audioTime(call.audio_duration_ms)}
          </dd>
        </div>
      </dl>
      {admin && call.actor && (
        <p className="break-all text-xs text-muted-foreground">
          {call.actor.display_name} · {call.actor.email}
        </p>
      )}
      {call.error_code && (
        <p className="break-all text-destructive">
          {tr("错误代码：")}
          {call.error_code}
          {call.error_reason ? ` · ${call.error_reason}` : ""}
        </p>
      )}
      <dl className="grid gap-x-6 gap-y-2 border-t border-dashed pt-3 text-xs sm:grid-cols-2 xl:grid-cols-3">
        {Object.entries(identifiers).map(([key, label]) => {
          const value = call[key as keyof Call];
          return typeof value === "string" ? (
            <div key={key} className="min-w-0">
              <dt className="text-muted-foreground">{tr(label)}</dt>
              <dd className="flex items-center gap-1">
                <span className="min-w-0 break-all tabular-nums">{value}</span>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`${tr("复制")} ${tr(label)}`}
                  loading={action.pendingKey === key}
                  onClick={() =>
                    void action.run(
                      async () => {
                        if (!(await copyText(value)))
                          throw new Error(tr("复制失败，请手动选择文字复制。"));
                      },
                      tr("已复制"),
                      key,
                    )
                  }
                >
                  <Copy />
                </Button>
              </dd>
            </div>
          ) : null;
        })}
      </dl>
      <ErrorBox message={action.error} />
    </article>
  );
}
