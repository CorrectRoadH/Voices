// @concord-file
// @concord-implements docs/feature/administration/README.md
// @concord-implements docs/feature/administration/use-case/inspect-instance.md
import { tr, interfaceLocale } from "@/lib/i18n";
import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ErrorBox, Loading, PageHeading, EmptyState } from "@/components/shared";
import { useResource } from "@/lib/hooks";
import { query } from "@/lib/api";

import type { Schema } from "@/lib/types";
type Overview = Schema["AdminOverview"];
const jobNames: Record<string, string> = {
  queued: "排队",
  running: "运行中",
  retry_wait: "等待重试",
  failed: "失败",
  restore_hold: "恢复暂停",
  stale_running: "运行租约过期",
};
export function AdminOverviewPage() {
  const resource = useResource<Overview>("/admin/overview");
  const d = resource.data;
  return (
    <>
      <PageHeading title={tr("站点概览")} />
      <div className="mb-5 flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{tr("当前数据库快照与响应实例的运行信息")}</p>
        <Button variant="outline" onClick={resource.refresh}>
          {tr("刷新概览")}{" "}
        </Button>
      </div>
      <ErrorBox message={resource.error} retry={resource.refresh} />
      {resource.loading ? (
        <Loading />
      ) : (
        d &&
        !resource.error && (
          <div className="grid gap-5 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{tr("服务状态")}</CardTitle>
                <CardDescription>
                  {new Date(d.checked_at).toLocaleString(interfaceLocale())}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Badge>
                  {tr("数据库可查询 ·")} {d.database.latency_ms} ms
                </Badge>
                <p>
                  {tr("恢复模式：{{state}}", {
                    state: d.restore_mode ? tr("开启") : tr("关闭状态"),
                  })}
                </p>
                <p>
                  {tr("本实例运行 {{minutes}} 分钟", {
                    minutes: Math.floor(d.uptime_seconds / 60),
                  })}
                </p>
                <p className="break-all text-xs text-muted-foreground">
                  {tr("实例")} {d.instance_id}
                </p>
                <p className="text-sm text-muted-foreground">
                  {tr("数据库可查询不代表后台任务或外部服务商健康。")}{" "}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{tr("账号与存储")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p>
                  {tr("账号总数：{{total}} · 已启用：{{active}} · 已停用：{{disabled}}", {
                    total: d.users.total,
                    active: d.users.active,
                    disabled: d.users.disabled,
                  })}
                </p>
                <p>{tr("有效管理员：{{count}}", { count: d.users.admins })}</p>
                <p>
                  {tr("已就绪存储块")} {(d.storage.blob_bytes / 1024 / 1024).toFixed(1)} MiB
                </p>
                <p className="text-sm text-muted-foreground">
                  {tr("包括原音频、转换文件与其他已保存块。")}{" "}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{tr("音频与转写任务")}</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-2 gap-3">
                  {Object.entries(jobNames).map(([key, label]) => (
                    <div key={key} className="rounded-md bg-muted p-3">
                      <dt className="text-sm text-muted-foreground">{tr(label)}</dt>
                      <dd className="text-xl font-semibold">
                        {key === "failed"
                          ? d.jobs.failed + d.jobs.uncertain
                          : d.jobs[key as keyof Overview["jobs"]]}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-4">
                  {tr("远端资源清理失败：")}
                  {d.cleanup_failed}
                </p>
                <p className="mt-3">
                  {tr("LLM 摘要：")}
                  {d.insights.queued} {tr("排队 ·")} {d.insights.running} {tr("生成中 ·")}{" "}
                  {d.insights.failed} {tr("失败")}{" "}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{tr("实例限制与日志")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p>
                  {tr("上传上限")} {(d.limits.max_upload_bytes / 1024 / 1024).toFixed(0)} MiB
                </p>
                <p>
                  {tr("音频准备并发")} {d.limits.prepare_concurrency} {tr("· 转写并发")}{" "}
                  {d.limits.transcription_concurrency}
                </p>
                <p>
                  {tr("本实例未写入的运行异常：")}
                  {d.runtime_log_dropped}
                </p>
                <p className="text-sm text-muted-foreground">
                  {tr(
                    "运行异常尽力记录，数据库故障或高并发时可能缺失。深入排障仍需查看容器日志。",
                  )}{" "}
                </p>
              </CardContent>
            </Card>
          </div>
        )
      )}
    </>
  );
}
const actions: Record<string, string> = {
  account_updated: "修改账号",
  registration_updated: "修改注册开关",
  server_settings_updated: "修改服务器设置",
  oidc_settings_updated: "修改统一登录配置",
  oidc_identity_linked: "绑定统一登录",
  oidc_identity_unlinked: "解绑统一登录",
  site_setup_completed: "完成站点初始化记录",
  password_reset: "重置密码",
  job_reconciled: "核对任务",
};
const detailLabels: Record<string, string> = {
  old_role: "原角色",
  role: "角色",
  old_status: "原状态",
  status: "状态",
  registration_open: "开放注册",
  fields: "修改字段",
  job_id: "任务 ID",
  operation_id: "操作 ID",
};
const detailValues: Record<string, string> = {
  admin: "管理员",
  user: "普通用户",
  active: "启用",
  disabled: "停用",
  public_base_url: "站点地址",
  allowed_origins: "可信来源",
  soniox_api_key: "Soniox 密钥",
  assemblyai_api_key: "AssemblyAI 密钥",
  llm_base_url: "LLM 地址",
  llm_model: "LLM 模型",
  llm_api_key: "LLM 密钥",
  enabled: "启用统一登录",
  display_name: "登录按钮名称",
  issuer_url: "Issuer URL",
  client_id: "Client ID",
  client_secret: "Client Secret",
};
function detailValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(detailValue).join("、");
  if (typeof value === "boolean") return value ? tr("是") : tr("否");
  return detailValues[String(value)] ? tr(detailValues[String(value)]) : String(value);
}
const kinds: Record<string, string> = {
  request_failed: "请求失败",
  job_failed: "任务失败",
  job_claim_failed: "任务领取失败",
  maintenance_failed: "维护失败",
  job_failure_persistence_failed: "任务失败状态保存失败",
};
type LogEvent = Partial<Schema["AuditEvent"] & Schema["RuntimeEvent"]> & {
  id: string;
  created_at: string;
};
type EventPage = { items: LogEvent[]; next_cursor: string | null };
function EventList({ runtime }: { runtime: boolean }) {
  const [params] = useSearchParams();
  const [filter, setFilter] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [requestID, setRequestID] = useState(runtime ? params.get("request_id") || "" : "");
  const [applied, setApplied] = useState<Record<string, string>>((): Record<string, string> =>
    runtime && params.get("request_id") ? { request_id: params.get("request_id")! } : {},
  );
  const [pages, setPages] = useState<string[]>([""]);
  const [validation, setValidation] = useState("");
  const resource = useResource<EventPage>(
    (runtime ? "/admin/runtime-events" : "/admin/audit-events") +
      query({ ...applied, cursor: pages.at(-1), limit: 50 }),
  );
  function apply(e: FormEvent) {
    e.preventDefault();
    if (from && to && from >= to) {
      setValidation(tr("起始时间须早于结束时间"));
      return;
    }
    setValidation("");
    setApplied({
      [runtime ? "kind" : "action"]: filter,
      from: from ? new Date(from).toISOString() : "",
      to: to ? new Date(to).toISOString() : "",
      ...(runtime ? { request_id: requestID.trim() } : {}),
    });
    setPages([""]);
  }
  return (
    <div className="space-y-5">
      <form onSubmit={apply} className="grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Field>
          <FieldLabel htmlFor={`${runtime}-kind`}>{tr("事件类型")}</FieldLabel>
          <NativeSelect
            id={`${runtime}-kind`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <NativeSelectOption value="">{tr("全部类型")}</NativeSelectOption>
            {Object.entries(runtime ? kinds : actions).map(([key, label]) => (
              <NativeSelectOption value={key} key={key}>
                {tr(label)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${runtime}-from`}>{tr("起始时间")}</FieldLabel>
          <Input
            id={`${runtime}-from`}
            type="datetime-local"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${runtime}-to`}>{tr("结束时间（不含）")}</FieldLabel>
          <Input
            id={`${runtime}-to`}
            type="datetime-local"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
        {runtime && (
          <Field>
            <FieldLabel htmlFor="request-id">{tr("请求 ID")}</FieldLabel>
            <Input
              id="request-id"
              value={requestID}
              onChange={(e) => setRequestID(e.target.value)}
              placeholder={tr("完整请求 UUID")}
            />
          </Field>
        )}
        <div className="flex gap-2">
          <Button type="submit">{tr("筛选日志")}</Button>
          <Button
            variant="outline"
            type="button"
            onClick={() => {
              setPages([""]);
              resource.refresh();
            }}
          >
            {tr("刷新")}{" "}
          </Button>
        </div>
      </form>
      <ErrorBox message={validation || resource.error} retry={resource.refresh} />
      {resource.loading ? (
        <Loading />
      ) : (
        resource.data &&
        !resource.error && (
          <>
            <div className="space-y-3">
              {resource.data.items.length === 0 ? (
                <EmptyState title={tr("没有匹配的日志")} />
              ) : (
                resource.data.items.map((item) => (
                  <Card key={item.id}>
                    <CardHeader>
                      <CardTitle>
                        {runtime
                          ? tr(kinds[item.kind || ""] || "运行异常")
                          : tr(actions[item.action || ""] || "管理事件")}
                      </CardTitle>
                      <CardDescription>
                        {new Date(item.created_at).toLocaleString(interfaceLocale())}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2 break-words text-sm">
                      {runtime ? (
                        <>
                          <p>
                            {item.code}
                            {item.status ? ` · HTTP ${item.status}` : ""}
                          </p>
                          {item.route && <p>{item.route}</p>}
                          {item.request_id && (
                            <p className="break-all">
                              {tr("请求：")}
                              {item.request_id}
                            </p>
                          )}
                          {item.job_id && (
                            <p className="break-all">
                              {tr("任务：")}
                              {item.job_id}
                            </p>
                          )}
                        </>
                      ) : (
                        <>
                          <p>
                            {tr("操作人：")}{" "}
                            {item.actor
                              ? `${item.actor.display_name} (${item.actor.email})`
                              : tr("服务器命令")}
                          </p>
                          {item.target && (
                            <p>
                              {tr("目标：")}
                              {item.target.display_name} ({item.target.email})
                            </p>
                          )}
                          {item.details &&
                            Object.entries(item.details).map(([key, value]) => (
                              <p key={key}>
                                {detailLabels[key] ? tr(detailLabels[key]) : key}:{" "}
                                {detailValue(value)}
                              </p>
                            ))}
                        </>
                      )}
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
            <div className="flex justify-between">
              <Button
                variant="outline"
                disabled={pages.length < 2}
                onClick={() => setPages((p) => p.slice(0, -1))}
              >
                {tr("上一页")}{" "}
              </Button>
              <Button
                variant="outline"
                disabled={!resource.data.next_cursor}
                onClick={() => setPages((p) => [...p, resource.data!.next_cursor!])}
              >
                {tr("下一页")}{" "}
              </Button>
            </div>
          </>
        )
      )}
    </div>
  );
}
export function AdminLogsPage() {
  const [params] = useSearchParams();
  return (
    <>
      <PageHeading title={tr("系统日志")} />
      <Tabs defaultValue={params.has("request_id") ? "runtime" : "audit"}>
        <TabsList>
          <TabsTrigger value="audit">{tr("管理审计")}</TabsTrigger>
          <TabsTrigger value="runtime">{tr("运行异常")}</TabsTrigger>
        </TabsList>
        <TabsContent value="audit" className="pt-5">
          <EventList runtime={false} />
        </TabsContent>
        <TabsContent value="runtime" className="space-y-5 pt-5">
          <p className="text-sm text-muted-foreground">
            {tr(
              "显示最近 7 天的结构化异常；不包含请求正文和服务商返回内容，也不替代容器日志。",
            )}{" "}
          </p>
          <EventList runtime />
        </TabsContent>
      </Tabs>
    </>
  );
}
