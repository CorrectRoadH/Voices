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
import { groupCalls } from "@/lib/call-groups";
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
  useEffect(() => {
    const abort = new AbortController();
    setNames({});
    void Promise.all(
      recordingIds
        .split(",")
        .filter(Boolean)
        .map(async (id) => {
          try {
            const recording = await request<Schema["Recording"]>(`/recordings/${id}`, {
              signal: abort.signal,
            });
            if (!abort.signal.aborted) setNames((old) => ({ ...old, [id]: recording.title }));
          } catch {
            /* A deleted or inaccessible recording keeps its neutral label. */
          }
        }),
    );
    return () => abort.abort();
  }, [recordingIds, endpoint]);
  function change(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }
  function select(key: string, label: string, options: Record<string, string>) {
    return (
      <Field key={key}>
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
      <details className="text-sm text-muted-foreground">
        <summary>{tr("关于调用记录")}</summary>
        <p className="mt-2">
          {tr(
            "调用成功不代表任务完成；音频时长和 token 用量不是费用账单。未返回的用量显示为未知。",
          )}
        </p>
      </details>
      <FieldGroup className="my-4 grid gap-3 sm:grid-cols-2">
        {select("category", "调用类别", { stt: "STT", ai: "AI" })}
        {select("state", "调用结果", states)}
      </FieldGroup>
      <details
        className="mb-4"
        open={
          ["operation", "provider", "model", "account", "from", "to"].some((key) =>
            params.has(key),
          ) || undefined
        }
      >
        <summary className="cursor-pointer text-sm">{tr("更多筛选")}</summary>
        <FieldGroup className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {select("operation", "调用操作", operations)}
          {select("provider", "服务商", {
            soniox: "Soniox",
            assemblyai: "AssemblyAI",
            openai_compatible: "OpenAI Compatible",
          })}
          <Field>
            <FieldLabel htmlFor="call-model">{tr("模型 ID")}</FieldLabel>
            <Input
              id="call-model"
              value={params.get("model") || ""}
              onChange={(e) => change("model", e.target.value)}
              maxLength={200}
            />
          </Field>
          {admin && (
            <Field>
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
            <Field key={key}>
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
      </details>
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
        <div className="divide-y rounded-lg border">
          {groupCalls(items).map((group) =>
            group.length === 1 ? (
              <CallRow
                key={group[0].id}
                call={group[0]}
                admin={admin}
                name={names[group[0].recording_id || ""]}
              />
            ) : (
              <details key={group[0].id} className="px-4 py-3">
                <summary className="cursor-pointer text-sm">
                  <span className="font-medium">
                    {names[group[0].recording_id || ""] || tr("查询进度")}
                  </span>
                  <span className="ml-3">
                    {tr("查询成功")} · {tr("已加载")} {group.length} {tr("次")}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {date(group[0].started_at)} · {group[0].provider} · {group[0].model}
                  </span>
                </summary>
                <div className="mt-2 divide-y">
                  {group.map((call) => (
                    <CallRow key={call.id} call={call} admin={admin} />
                  ))}
                </div>
              </details>
            ),
          )}
        </div>
      )}
      {filter && (
        <Button variant="ghost" size="sm" onClick={() => setParams({}, { replace: true })}>
          {tr("清除筛选")}
        </Button>
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
  return (
    <article className="flex min-w-0 flex-col gap-2 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {call.can_open_recording && call.recording_id && (
          <Link
            className="min-w-0 break-words font-medium underline underline-offset-4"
            to={`/recordings/${call.recording_id}`}
          >
            {name || tr("查看录音")}
          </Link>
        )}
        <span className="font-medium">{tr(operations[call.operation] || call.operation)}</span>
        <Badge variant={call.state === "failed" ? "destructive" : "secondary"}>
          {tr(states[call.state] || call.state)}
        </Badge>
        <span className="text-xs tabular-nums text-muted-foreground">{date(call.started_at)}</span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="break-all">
          {call.provider}
          {call.model ? ` · ${call.model}` : ""}
        </span>
        {admin && call.actor && (
          <span className="break-all">
            {call.actor.display_name} · {call.actor.email}
          </span>
        )}
        <span>HTTP: {metric(call.http_status)}</span>
        <span>
          {tr("耗时")}:{" "}
          {call.duration_ms === null ? tr("未知") : `${(call.duration_ms / 1000).toFixed(2)} s`}
        </span>
        {call.category === "ai" ? (
          <span>
            {tr("输入 / 输出 / 总 token")}: {metric(call.input_tokens)} /{" "}
            {metric(call.output_tokens)} / {metric(call.total_tokens)}
          </span>
        ) : (
          <span>
            {tr("音频时长")}:{" "}
            {call.audio_duration_ms === null ? tr("未知") : audioTime(call.audio_duration_ms)}
          </span>
        )}
      </div>
      {call.error_code && (
        <p className="break-all text-destructive">
          {tr("错误代码：")}
          {call.error_code}
          {call.error_reason ? ` · ${call.error_reason}` : ""}
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">{tr("调用详情")}</summary>
        <dl className="mt-2 grid gap-3 text-xs sm:grid-cols-2">
          {["id", "job_id", "recording_id", "transcription_id", "operation_id", "generation"].map(
            (key) => {
              const value = call[key as keyof Call];
              return typeof value === "string" ? (
                <div key={key} className="min-w-0">
                  <dt className="text-muted-foreground">{key}</dt>
                  <dd className="flex items-start gap-2">
                    <span className="break-all">{value}</span>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`${tr("复制")} ${key}`}
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
            },
          )}
          <div>
            <dt>{tr("请求已发起")}</dt>
            <dd>
              {tr(call.request_started === null ? "未知" : call.request_started ? "是" : "否")}
            </dd>
          </div>
        </dl>
        <ErrorBox message={action.error} />
      </details>
    </article>
  );
}
