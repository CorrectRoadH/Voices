// @concord-file
// @concord-implements docs/feature/stt-pricing/README.md
// @concord-implements docs/feature/stt-pricing/use-case/manage-estimates.md
import { DatePicker } from "@/components/date-picker";
import { Spinner } from "@/components/ui/spinner";
import { useRef, useState, type FormEvent } from "react";
import { tr, interfaceLocale } from "@/lib/i18n";
import { query, write } from "@/lib/api";
import { useAction, useResource } from "@/lib/hooks";
import { usePagedResource } from "@/lib/use-paged-resource";
import type { Page, Provider, Schema } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Field, FieldLabel, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { ErrorBox, EmptyState, Loading, PageHeading } from "@/components/shared";

type Call = Schema["STTCall"];
type Price = Schema["STTPrice"];
const notice = "按音频时长估算，实际账单以服务商为准";
const labels: Record<string, string> = {
  prepared: "准备提交",
  sent: "已发送，待确认",
  known: "已确认受理",
  uncertain: "结果待确认",
  confirmed_absent: "已确认未受理",
  pending: "等待处理",
  running: "处理中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  submission: "提交意图",
  historical: "历史未定价",
  restore_observation: "恢复观察（未定价）",
};
export function sttMoney(value: string | null) {
  if (value === null) return tr("未定价");
  const amount = BigInt(value);
  return `USD ${amount / 1000000n}.${(amount % 1000000n).toString().padStart(6, "0")}`;
}
function TextField({
  name,
  label,
  type = "text",
  value,
  change,
  required = false,
}: {
  name: string;
  label: string;
  type?: string;
  value: string;
  change: (value: string) => void;
  required?: boolean;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={name}>{tr(label)}</FieldLabel>
      {type === "date" || type === "datetime-local" ? (
        <DatePicker
          id={name}
          dateOnly={type === "date"}
          value={value}
          required={required}
          onValueChange={change}
        />
      ) : (
        <Input
          id={name}
          type={type}
          value={value}
          required={required}
          onChange={(e) => change(e.target.value)}
        />
      )}
    </Field>
  );
}
function ProviderField({
  value,
  change,
  all = true,
}: {
  value: string;
  change: (value: string) => void;
  all?: boolean;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={all ? "stt-provider" : "price-provider"}>{tr("服务商")}</FieldLabel>
      <NativeSelect
        id={all ? "stt-provider" : "price-provider"}
        value={value}
        onChange={(e) => change(e.target.value)}
      >
        {all && <NativeSelectOption value="">{tr("全部")}</NativeSelectOption>}
        <NativeSelectOption value="soniox">Soniox</NativeSelectOption>
        <NativeSelectOption value="assemblyai">AssemblyAI</NativeSelectOption>
      </NativeSelect>
    </Field>
  );
}
export function AdminSTTCallsPage() {
  const blank = {
    from: "",
    to: "",
    owner_id: "",
    provider: "",
    model: "",
    state: "",
    submission_state: "",
  };
  const [draft, setDraft] = useState(blank);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const calls = usePagedResource<Call>("/admin/stt/calls" + filter, "admin-stt-calls");
  const summary = useResource<Schema["STTSummary"]>("/admin/stt/summary" + filter);
  const change = (key: keyof typeof blank) => (value: string) =>
    setDraft((old) => ({ ...old, [key]: value }));
  function apply(e: FormEvent) {
    e.preventDefault();
    if (draft.from && draft.to && draft.from >= draft.to) {
      setError(tr("起始时间须早于结束时间"));
      return;
    }
    setError("");
    setFilter(
      query({
        ...draft,
        from: draft.from ? new Date(draft.from).toISOString() : "",
        to: draft.to ? new Date(draft.to).toISOString() : "",
      }),
    );
  }
  const totals = summary.data?.totals;
  return (
    <div className="flex flex-col gap-5">
      <PageHeading title={tr("STT 调用")} />
      <p className="text-sm text-muted-foreground">{tr(notice)}</p>
      <form onSubmit={apply} className="flex flex-col gap-4">
        <FieldGroup className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <TextField
            name="stt-from"
            label="开始时间"
            type="datetime-local"
            value={draft.from}
            change={change("from")}
          />
          <TextField
            name="stt-to"
            label="结束时间"
            type="datetime-local"
            value={draft.to}
            change={change("to")}
          />
          <ProviderField value={draft.provider} change={change("provider")} />
          <TextField
            name="stt-model"
            label="模型 ID"
            value={draft.model}
            change={change("model")}
          />
          <TextField
            name="stt-owner"
            label="账号 ID"
            value={draft.owner_id}
            change={change("owner_id")}
          />
          {(["state", "submission_state"] as const).map((key) => (
            <Field key={key}>
              <FieldLabel htmlFor={key}>
                {tr(key === "state" ? "结果状态" : "提交确认状态")}
              </FieldLabel>
              <NativeSelect
                id={key}
                value={draft[key]}
                onChange={(e) => change(key)(e.target.value)}
              >
                <NativeSelectOption value="">{tr("全部")}</NativeSelectOption>
                {(key === "state"
                  ? ["pending", "running", "succeeded", "failed", "cancelled"]
                  : ["prepared", "sent", "known", "uncertain", "confirmed_absent"]
                ).map((v) => (
                  <NativeSelectOption key={v} value={v}>
                    {tr(labels[v])}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          ))}
        </FieldGroup>
        <div className="flex flex-wrap gap-2">
          <Button type="submit">{tr("筛选")}</Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setDraft(blank);
              setFilter("");
              setError("");
            }}
          >
            {tr("清除筛选")}
          </Button>
          <Button
            type="button"
            variant="outline"
            aria-busy={calls.updating || summary.refreshing}
            disabled={calls.updating || summary.refreshing}
            onClick={() => {
              calls.refresh();
              summary.refresh();
            }}
          >
            {(calls.updating || summary.refreshing) && (
              <Spinner data-icon="inline-start" aria-hidden="true" />
            )}
            {tr("刷新")}
          </Button>
        </div>
      </form>
      <ErrorBox message={error || summary.error} retry={summary.refresh} />
      {summary.loading && <Loading />}
      {totals && (
        <Card>
          <CardHeader>
            <CardTitle>{tr("筛选范围汇总")}</CardTitle>
            <CardDescription>
              {tr("未定价独立计数，不代表零费用。恢复观察不计新提交。")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[
                ["提交意图数", totals.submitted_count],
                ["已完成时长（秒）", (BigInt(totals.completed_duration_ms) / 1000n).toString()],
                ["已完成估算费用", sttMoney(totals.completed_estimated_cost_microusd)],
                ["进行中估算费用", sttMoney(totals.pending_estimated_cost_microusd)],
                ["结果待确认", totals.uncertain_count],
                ["未定价", totals.unpriced_count],
                ["恢复观察", totals.restored_count],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-sm text-muted-foreground">{tr(label)}</dt>
                  <dd className="break-all tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      )}
      <ErrorBox message={calls.error} retry={calls.refresh} />
      {calls.updating && <p role="status">{tr("正在更新")}</p>}
      {!calls.loading && !calls.error && calls.items.length === 0 && (
        <EmptyState title={tr("没有匹配的 STT 调用")} />
      )}
      {calls.items.map((c) => (
        <Card key={c.id}>
          <CardHeader>
            <CardTitle>
              {c.provider} · {c.model}
            </CardTitle>
            <CardDescription>
              {new Date(c.created_at).toLocaleString(interfaceLocale())} · {c.email}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {[
                ["结果状态", tr(labels[c.result_state])],
                ["提交确认状态", tr(labels[c.submission_state])],
                ["记录来源", tr(labels[c.origin])],
                ["音频时长（毫秒）", c.duration_ms],
                ["预计费用", sttMoney(c.estimated_cost_microusd)],
                ["任务重试计数", String(c.job_attempt)],
                ["说话人区分", c.diarization ? tr("是") : tr("否")],
                ["参考小时价", sttMoney(c.rate_microusd_per_hour)],
                ["调用 ID", c.id],
                ["账号 ID", c.owner_id],
                ["任务 ID", c.job_id],
                ["操作 ID", c.operation_id],
                ["转写 ID", c.transcription_id],
                ["价格版本", c.price_version_id],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-muted-foreground">{tr(label ?? "")}</dt>
                  <dd className="break-all">{value ?? "—"}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      ))}
      {calls.nextCursor && (
        <Button
          variant="outline"
          aria-busy={calls.loading && !calls.updating}
          disabled={calls.updating || (calls.loading && !calls.updating)}
          onClick={calls.loadMore}
        >
          {calls.loading && !calls.updating && (
            <Spinner data-icon="inline-start" aria-hidden="true" />
          )}
          {tr("加载更多")}
        </Button>
      )}
    </div>
  );
}
export function AdminSTTPricesPage() {
  const [history, setHistory] = useState(false);
  const [filter, setFilter] = useState({ provider: "", model: "" });
  const prices = usePagedResource<Price>(
    "/admin/stt/prices" + query({ ...filter, history }),
    "admin-stt-prices",
  );
  const providers = useResource<Page<Provider>>("/providers");
  const action = useAction();
  const [draft, setDraft] = useState<Schema["STTPriceInput"]>({
    provider: "soniox",
    model: "",
    currency: "USD",
    basis: "duration_estimate",
    hourly_rate_microusd: "",
    diarization_hourly_rate_microusd: "0",
    source: "",
    verified_on: new Date().toISOString().slice(0, 10),
  });
  const attempt = useRef({ body: "", key: "" });
  const models = providers.data?.items.find((p) => p.id === draft.provider)?.models ?? [];
  const update = (key: keyof typeof draft) => (value: string) =>
    setDraft((old) => ({ ...old, [key]: value }));
  async function save(e: FormEvent) {
    e.preventDefault();
    const body = JSON.stringify(draft);
    if (attempt.current.body !== body) attempt.current = { body, key: crypto.randomUUID() };
    await action.run(async () => {
      await write("/admin/stt/prices", "POST", draft, attempt.current.key);
      prices.refresh();
    }, tr("参考价已保存"));
  }
  return (
    <div className="flex flex-col gap-5">
      <PageHeading title={tr("模型价格")} />
      <p className="text-sm text-muted-foreground">{tr(notice)}</p>
      <Card>
        <CardHeader>
          <CardTitle>{tr("追加参考价")}</CardTitle>
          <CardDescription>
            {tr("金额使用 USD 微元，每小时 1 USD = 1000000 微元。已有调用不会重新计价。")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={save} className="flex flex-col gap-4">
            <FieldGroup className="grid gap-4 sm:grid-cols-2">
              <ProviderField
                all={false}
                value={draft.provider}
                change={(value) => setDraft((old) => ({ ...old, provider: value, model: "" }))}
              />
              <Field>
                <FieldLabel htmlFor="price-model">{tr("模型")}</FieldLabel>
                <NativeSelect
                  id="price-model"
                  required
                  value={draft.model}
                  onChange={(e) => update("model")(e.target.value)}
                >
                  <NativeSelectOption value="">{tr("选择模型")}</NativeSelectOption>
                  {models.map((m) => (
                    <NativeSelectOption value={m.id} key={m.id}>
                      {m.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <TextField
                name="price-hourly"
                label="基础价（微元/小时）"
                required
                value={draft.hourly_rate_microusd}
                change={update("hourly_rate_microusd")}
              />
              <TextField
                name="price-diarization"
                label="说话人区分附加价（微元/小时）"
                required
                value={draft.diarization_hourly_rate_microusd}
                change={update("diarization_hourly_rate_microusd")}
              />
              <TextField
                name="price-source"
                label="价格来源"
                required
                value={draft.source}
                change={update("source")}
              />
              <TextField
                name="price-verified"
                label="核对日期"
                type="date"
                required
                value={draft.verified_on}
                change={update("verified_on")}
              />
            </FieldGroup>
            <ErrorBox message={action.error || providers.error} />
            <Button type="submit" aria-busy={action.busy} disabled={!models.length || action.busy}>
              {action.busy && <Spinner data-icon="inline-start" aria-hidden="true" />}
              {tr("保存新价格版本")}
            </Button>
          </form>
        </CardContent>
      </Card>
      <FieldGroup className="grid gap-4 sm:grid-cols-2">
        <ProviderField
          value={filter.provider}
          change={(provider) => setFilter((old) => ({ ...old, provider }))}
        />
        <TextField
          name="price-filter-model"
          label="模型 ID"
          value={filter.model}
          change={(model) => setFilter((old) => ({ ...old, model }))}
        />
      </FieldGroup>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => setHistory((v) => !v)}>
          {tr(history ? "查看最新价格" : "查看历史版本")}
        </Button>
        <Button
          variant="outline"
          aria-busy={prices.updating}
          disabled={prices.updating}
          onClick={prices.refresh}
        >
          {prices.updating && <Spinner data-icon="inline-start" aria-hidden="true" />}
          {tr("刷新")}
        </Button>
      </div>
      <ErrorBox message={prices.error} retry={prices.refresh} />
      {prices.updating && <p role="status">{tr("正在更新")}</p>}
      {!prices.loading && !prices.error && prices.items.length === 0 && (
        <EmptyState title={tr("没有匹配的价格版本")} />
      )}
      {prices.items.map((p) => (
        <Card key={p.id}>
          <CardHeader>
            <CardTitle>
              {p.provider} · {p.model}
            </CardTitle>
            <CardDescription>
              {new Date(p.created_at).toLocaleString(interfaceLocale())}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              {[
                ["基础价（每小时）", sttMoney(p.hourly_rate_microusd)],
                ["说话人区分附加价（每小时）", sttMoney(p.diarization_hourly_rate_microusd)],
                ["价格来源", p.source],
                ["核对日期", p.verified_on],
                ["价格版本", p.id],
                ["创建账号 ID", p.created_by],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-muted-foreground">{tr(label)}</dt>
                  <dd className="break-all">{value}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      ))}
      {prices.nextCursor && (
        <Button
          variant="outline"
          aria-busy={prices.loading && !prices.updating}
          disabled={prices.updating || (prices.loading && !prices.updating)}
          onClick={prices.loadMore}
        >
          {prices.loading && !prices.updating && (
            <Spinner data-icon="inline-start" aria-hidden="true" />
          )}
          {tr("加载更多")}
        </Button>
      )}
    </div>
  );
}
