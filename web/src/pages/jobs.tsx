// @concord-file
// @concord-implements docs/feature/transcription/use-case/transcribe.md
import { tr } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ExternalLink, RefreshCw, ShieldQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  PageHeading,
  ErrorBox,
  Loading,
  EmptyState,
  More,
  Modal,
  Status,
} from "@/components/shared";
import { useAction, useApp, useResource } from "@/lib/hooks";
import { query, write } from "@/lib/api";
import { date, stateName } from "@/lib/format";
import { jobError } from "@/lib/job-error";
import type { Job, Page } from "@/lib/types";
export function canRetry(job: Job) {
  return job.retry_allowed === true;
}
export function JobsPage() {
  const { session } = useApp();
  const [params, setParams] = useSearchParams();
  const [cursor, setCursor] = useState("");
  const [items, setItems] = useState<Job[]>([]);
  const [resolve, setResolve] = useState<Job | null>(null);
  const [operationId, setOperationId] = useState("");
  const [remoteId, setRemoteId] = useState("");
  const [note, setNote] = useState("");
  const data = useResource<Page<Job>>(
    `/jobs${query({ state: params.get("state"), recording_id: params.get("recording_id"), cursor, limit: 50 })}`,
    0,
    7000,
  );
  const action = useAction();
  useEffect(() => {
    setCursor("");
    setItems([]);
  }, [params]);
  useEffect(() => {
    if (data.data)
      setItems((old) =>
        cursor
          ? [
              ...old.filter((j) => !data.data!.items.some((n) => n.id === j.id)),
              ...data.data!.items,
            ]
          : data.data!.items,
      );
  }, [data.data, cursor]);
  return (
    <>
      <PageHeading title={tr("处理任务")}>
        <Button variant="outline" onClick={data.refresh}>
          <RefreshCw data-icon="inline-start" />
          {tr("刷新")}{" "}
        </Button>
      </PageHeading>
      {items.some((job) => ["uncertain", "restore_hold"].includes(job.state)) && (
        <Alert>
          <ShieldQuestion />
          <AlertTitle>{tr("安全恢复任务")}</AlertTitle>
          <AlertDescription>
            {tr(
              "结果待确认的任务不会自动重试。你可以确认风险后重新转写，也可以登记核对结果；恢复待核对的任务须先完成核对。",
            )}{" "}
          </AlertDescription>
        </Alert>
      )}
      <FieldGroup className="mt-5 max-w-xs">
        <Field>
          <FieldLabel htmlFor="job-filter">{tr("任务状态")}</FieldLabel>
          <NativeSelect
            id="job-filter"
            value={params.get("state") || ""}
            onChange={(e) => {
              const next = new URLSearchParams(params);
              e.target.value ? next.set("state", e.target.value) : next.delete("state");
              setParams(next);
            }}
          >
            <NativeSelectOption value="">{tr("全部任务")}</NativeSelectOption>
            {[
              "queued",
              "running",
              "retry_wait",
              "uncertain",
              "restore_hold",
              "succeeded",
              "failed",
              "cancelled",
            ].map((s) => (
              <NativeSelectOption key={s} value={s}>
                {stateName(s)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </FieldGroup>
      <ErrorBox message={data.error} retry={data.refresh} />
      {data.loading && !items.length ? (
        <Loading />
      ) : items.length ? (
        <div className="mt-5 flex flex-col gap-4">
          {items.map((job) => (
            <Card key={job.id}>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle>
                    {job.kind === "transcribe" || job.kind === "transcription"
                      ? tr("音频转写")
                      : job.kind === "prepare"
                        ? tr("音频预处理")
                        : job.kind}
                  </CardTitle>
                  <Status value={job.state} />
                </div>
                <CardDescription>
                  {date(job.created_at)} {tr("· 失败")} {job.attempt} {tr("次 · 阶段：")}
                  {stateName(job.stage)}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="break-all text-xs text-muted-foreground">
                  {tr("任务 ID：")}
                  {job.id}
                </p>
                {job.error_code && (
                  <div className="mt-2 flex flex-col gap-1 text-sm">
                    <p className="text-destructive">{jobError(job)}</p>
                    <p className="text-xs text-muted-foreground">
                      {tr("错误代码：")}
                      {job.error_code}
                    </p>
                  </div>
                )}
                {["uncertain", "restore_hold"].includes(job.state) && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {tr("此任务可能已在服务商受理，不能安全重试或宣称清理完成。")}{" "}
                  </p>
                )}
              </CardContent>
              <CardFooter className="flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  nativeButton={false}
                  render={
                    <Link
                      to={
                        job.transcription_id
                          ? `/recordings/${job.recording_id}/transcriptions/${job.transcription_id}`
                          : `/recordings/${job.recording_id}`
                      }
                    />
                  }
                >
                  <ExternalLink data-icon="inline-start" />
                  {tr("查看录音")}{" "}
                </Button>
                {canRetry(job) && !session.restore_mode && (
                  <Button
                    loading={action.pendingKey === job.id}
                    size="sm"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(
                        async () => {
                          await write(`/jobs/${job.id}/retry`, "POST", {});
                          data.refresh();
                        },
                        tr("已请求恢复安全阶段"),
                        job.id,
                      )
                    }
                  >
                    {tr("重试")}{" "}
                  </Button>
                )}
                {job.state === "uncertain" &&
                  job.kind === "transcribe" &&
                  !session.restore_mode && (
                    <Button
                      size="sm"
                      nativeButton={false}
                      render={
                        <Link
                          to={`/recordings/${job.recording_id}/transcriptions/${job.transcription_id}?new_transcription=1`}
                        />
                      }
                    >
                      {tr("重新转写")}
                    </Button>
                  )}
                {["uncertain", "restore_hold"].includes(job.state) && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setResolve(job);
                      setOperationId(job.operations?.length === 1 ? job.operations[0].id : "");
                      setRemoteId("");
                      setNote("");
                    }}
                  >
                    {tr("登记核对结果")}{" "}
                  </Button>
                )}
              </CardFooter>
            </Card>
          ))}
        </div>
      ) : (
        !data.error && (
          <EmptyState
            title={tr("暂无处理任务")}
            description={tr("导入录音或创建转写后，可以在这里跟踪进度。")}
          />
        )
      )}
      <More cursor={data.data?.next_cursor} loading={data.loading} onLoad={setCursor} />
      <Modal
        title={tr("登记远端 ID 或查询观察")}
        description={tr("仅登记已核实的信息，不触发新的付费请求。“暂未查到”会保留待确认状态。")}
        open={!!resolve}
        onOpenChange={(v) => {
          if (!v && !action.busy) setResolve(null);
        }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!resolve) return;
            void action.run(async () => {
              await write(`/jobs/${resolve.id}/resolve`, "POST", {
                ...(operationId ? { operation_id: operationId } : {}),
                ...(remoteId ? { remote_id: remoteId } : {}),
                note,
              });
              setResolve(null);
              data.refresh();
            }, tr("核对记录已保存；任务状态由服务器核实"));
          }}
        >
          <FieldGroup>
            <ErrorBox message={action.error} />
            <Field>
              <FieldLabel htmlFor="operation-id">{tr("核对的远端操作")}</FieldLabel>
              {resolve?.operations?.length ? (
                <NativeSelect
                  id="operation-id"
                  value={operationId}
                  required
                  onChange={(e) => {
                    setOperationId(e.target.value);
                    setRemoteId("");
                  }}
                >
                  <NativeSelectOption value="">{tr("请选择操作")}</NativeSelectOption>
                  {resolve.operations.map((operation) => (
                    <NativeSelectOption key={operation.id} value={operation.id}>
                      {operation.kind === "upload"
                        ? tr("上传音频")
                        : operation.kind === "submit"
                          ? tr("提交转写")
                          : operation.kind}{" "}
                      · {stateName(operation.state)} · {operation.id}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              ) : (
                <Input
                  id="operation-id"
                  value={operationId}
                  onChange={(e) => setOperationId(e.target.value)}
                  placeholder={tr("操作 ID（可选）")}
                />
              )}
              <FieldDescription>
                {tr("同一任务有多个操作时，须先确认核对的是上传还是转写提交。")}{" "}
              </FieldDescription>
              {resolve?.operations
                ?.filter((operation) => operation.id === operationId)
                .map((operation) => (
                  <div
                    key={operation.id}
                    className="flex flex-col gap-2 text-sm text-muted-foreground"
                  >
                    <p className="break-all">
                      {tr("已登记远端 ID：")}
                      {operation.remote_id || tr("尚无")}
                    </p>
                    <p className="whitespace-pre-wrap">
                      {tr("既有核对说明：")}
                      {operation.resolution_note || tr("尚无")}
                    </p>
                  </div>
                ))}
            </Field>
            <Field>
              <FieldLabel htmlFor="remote-id">{tr("已核实的远端 ID（可选）")}</FieldLabel>
              <Input
                id="remote-id"
                value={remoteId}
                onChange={(e) => setRemoteId(e.target.value)}
              />
              <FieldDescription>
                {tr("只能确认此操作已经登记的 ID。未知 ID 请联系运维者；留空则仅保存查询观察。")}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="resolve-note">{tr("核对说明")}</FieldLabel>
              <Textarea
                id="resolve-note"
                required
                value={note}
                rows={4}
                onChange={(e) => setNote(e.target.value)}
                placeholder={tr("例如：在服务商控制台按时间查询，暂未查到。")}
              />
            </Field>
            <Button
              loading={action.busy}
              disabled={
                action.busy || !note.trim() || (!!resolve?.operations?.length && !operationId)
              }
              type="submit"
            >
              {tr("保存核对记录")}{" "}
            </Button>
          </FieldGroup>
        </form>
      </Modal>
    </>
  );
}
