// @concord-file
// @concord-implements docs/feature/transcription/use-case/transcribe.md
import { Link } from "react-router-dom";
import { tr } from "@/lib/i18n";
import { stateName } from "@/lib/format";
import type { Job, Recording, Transcription } from "@/lib/types";
import { Button } from "./ui/button";
import { EmptyState, ErrorBox, Loading } from "./shared";

export function RecordingProgress({
  recording,
  transcription,
  jobs,
  loading,
  onManage,
}: {
  recording: Recording;
  transcription?: Transcription | null;
  jobs: Job[];
  loading: boolean;
  onManage: () => void;
}) {
  if (loading) return <Loading />;
  const job = jobs.find((item) =>
    recording.state === "preparing" || !transcription
      ? item.kind === "prepare"
      : item.transcription_id === transcription.id && item.kind === "transcribe",
  );
  const state =
    recording.state === "failed" || job?.state === "failed"
      ? "failed"
      : recording.state === "preparing"
        ? "preparing"
        : transcription?.state;
  const pending = !!state && ["preparing", "queued", "running", "retry_wait"].includes(state);
  const needsAttention = !!state && ["uncertain", "restore_hold"].includes(state);
  return (
    <div className="flex flex-col items-start gap-4 py-6">
      {pending ? (
        <div className="w-full">
          <Loading
            title={
              state === "preparing"
                ? tr("正在准备音频")
                : state === "queued"
                  ? tr("转写排队中")
                  : state === "retry_wait"
                    ? tr("等待重试")
                    : tr("正在转写")
            }
            description={
              state === "preparing"
                ? tr("正在生成播放副本，完成后将继续转写。你可以离开此页，后台会继续处理。")
                : tr("完成后会自动显示转写结果，你可以先处理其他录音。")
            }
          />
          {job && (
            <p className="mt-3 text-xs text-muted-foreground">
              {tr("当前阶段：")} {stateName(job.stage)}
            </p>
          )}
        </div>
      ) : state === "failed" ? (
        <ErrorBox
          message={
            tr("处理失败，请查看任务详情后重试。") +
            (transcription?.error_code ? ` (${transcription.error_code})` : "")
          }
        />
      ) : needsAttention ? (
        <EmptyState
          title={stateName(state!)}
          description={tr("任务需要核对，请查看任务详情；确认前不会重复提交。")}
        />
      ) : state === "succeeded" ? (
        <EmptyState
          title={tr("已完成")}
          description={tr("在版本与导出中选择转写版本以阅读结果。")}
        />
      ) : (
        <EmptyState
          title={state === "cancelled" ? tr("已取消") : tr("暂无转写")}
          description={tr(
            "选择语言与模型，生成第一份转写。没有成功版本时，可在版本列表查看处理中版本。",
          )}
        />
      )}
      <div className="flex flex-wrap gap-2">
        {(pending || needsAttention || state === "failed") && (
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link to={`/jobs?recording_id=${recording.id}`} />}
          >
            {tr("查看任务")}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onManage}>
          {tr("版本与导出")}
        </Button>
      </div>
    </div>
  );
}
