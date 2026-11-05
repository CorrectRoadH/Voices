// @concord-file
// @concord-implements docs/feature/people/use-case/recognize-speaker.md
import { useEffect, useRef } from "react";
import { useAction, useApp, useForegroundRefresh, useResource } from "@/lib/hooks";
import { write } from "@/lib/api";
import { tr } from "@/lib/i18n";
import type { Schema } from "@/lib/types";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { ErrorBox, Loading } from "./shared";

export function PersonVoiceprints({ id, archived }: { id: string; archived: boolean }) {
  const path = `/people/${encodeURIComponent(id)}/voiceprints`;
  const data = useResource<Schema["PersonVoiceprints"]>(path);
  useForegroundRefresh(
    () => {
      if (!data.refreshing) data.refresh();
    },
    (data.data?.pending ?? 0) > 0 ? 5000 : 0,
  );
  const action = useAction();
  const { session } = useApp();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{tr("人物声纹")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ErrorBox message={data.error || action.error} retry={data.refresh} />
        {data.loading ? (
          <Loading />
        ) : (
          data.data && (
            <>
              <p role="status">
                {data.data.pending > 0
                  ? tr("正在建立声纹…")
                  : data.data.samples > 0
                    ? tr("已建立 {{v0}} 份样本，共 {{v1}} 秒", {
                        v0: data.data.samples,
                        v1: Math.round(data.data.sample_ms / 1000),
                      })
                    : tr("暂无可用声纹")}
              </p>
              <p className="text-sm text-muted-foreground">
                {tr("人工确认的清晰发言会用于识别后续录音；至少需要两段、合计六秒。")}
              </p>
              {!archived && (
                <Button
                  variant="outline"
                  disabled={session.restore_mode || action.busy || data.data.pending > 0}
                  loading={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      data.setData(await write<Schema["PersonVoiceprints"]>(path, "POST"));
                    }, tr("已安排声纹更新"))
                  }
                >
                  {tr("从已标识录音更新声纹")}
                </Button>
              )}
            </>
          )
        )}
      </CardContent>
    </Card>
  );
}

export function TranscriptionVoiceprints({
  id,
  revision,
  onPublished,
}: {
  id: string;
  revision: number;
  onPublished: () => void;
}) {
  const path = `/transcriptions/${encodeURIComponent(id)}/voiceprints`;
  const data = useResource<Schema["TranscriptionVoiceprints"]>(path, revision);
  const task = data.data?.task;
  const busy = task?.state === "queued" || task?.state === "running";
  useForegroundRefresh(
    () => {
      if (!data.refreshing) data.refresh();
    },
    busy ? 5000 : 0,
  );
  const action = useAction();
  const { session } = useApp();
  const seen = useRef("");
  const published = useRef(onPublished);
  published.current = onPublished;
  useEffect(() => {
    const task = data.data?.task;
    if (task?.state !== "succeeded") return;
    const key = `${id}:${task.generation}:${task.updated_at}`;
    if (seen.current === key) return;
    seen.current = key;
    published.current();
  }, [id, data.data]);
  return (
    <div className="flex flex-col gap-2" aria-label={tr("声纹识别")}>
      <ErrorBox message={data.error || action.error} retry={data.refresh} />
      {data.data && (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            {busy
              ? tr("正在识别说话人…")
              : task?.state === "failed"
                ? tr("声纹处理失败，可重试；转写不受影响。")
                : task?.state === "succeeded"
                  ? data.data.samples > 0
                    ? tr("声纹比对完成，明确匹配的人物已自动关联。")
                    : tr("没有足够清晰的语音，保留当前人物标识。")
                  : tr("尚未进行声纹识别")}
          </p>
          {task?.error_code && <p className="text-xs text-muted-foreground">{task.error_code}</p>}
          {
            <Button
              size="sm"
              variant="outline"
              loading={action.busy}
              disabled={session.restore_mode || action.busy || busy}
              onClick={() =>
                void action.run(async () => {
                  data.setData(await write<Schema["TranscriptionVoiceprints"]>(path, "POST"));
                }, tr("已安排声纹更新"))
              }
            >
              {tr("重新比对声纹")}
            </Button>
          }
        </>
      )}
    </div>
  );
}
