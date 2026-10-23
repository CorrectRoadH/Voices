// @concord-file
// @concord-implements docs/feature/insights/README.md
// @concord-implements docs/feature/insights/use-case/generate-insights.md
import { useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "@/lib/hooks";
import { tr, interfaceLocale } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ErrorBox, Loading, Modal } from "@/components/shared";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@/components/ui/empty";
import { duration } from "@/lib/format";
import type { Schema } from "@/lib/types";
export type InsightsResponse = Schema["InsightsResponse"];
const failures: Record<string, string> = {
  llm_unavailable: "模型服务暂时不可用",
  llm_rejected: "模型服务拒绝请求，请检查兼容性、配置与额度",
  invalid_response: "模型返回的摘要或章节无法通过校验",
  interrupted: "生成已中断",
  configuration_changed: "生成期间模型配置已变更",
  account_disabled: "账号已停用",
};
export function InsightOutline({
  view = "outline",
  data,
  error,
  busy,
  disabled,
  hasTranscription,
  onGenerate,
  onRefresh,
  onJump,
}: {
  view?: "outline" | "summary";
  data: InsightsResponse | null;
  error: string;
  busy: boolean;
  disabled: boolean;
  hasTranscription: boolean;
  onGenerate: () => void;
  onRefresh: () => void;
  onJump: (id: string) => void;
}) {
  const [summaryOpen, setSummaryOpen] = useState(false);
  const { session } = useApp();
  const emptyTitle = view === "summary" ? tr("尚未生成摘要") : tr("尚未生成主题目录");
  const generatingTitle = view === "summary" ? tr("摘要生成中…") : tr("主题目录生成中…");
  if (!hasTranscription)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{emptyTitle}</EmptyTitle>
          <EmptyDescription>
            {view === "summary" ? tr("完成转写后可生成摘要。") : tr("完成转写后可生成目录。")}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  const insight = data?.insight;
  const pending = insight?.state === "queued" || insight?.state === "running";
  const failed = insight?.state === "failed";
  const succeeded = data?.configured && insight?.state === "succeeded";
  if (!data && !error) return <Loading />;
  if (pending && !error)
    return <Loading title={insight.state === "queued" ? tr("等待生成…") : generatingTitle} />;
  const generate = (
    <Button
      loading={busy || pending}
      size="sm"
      variant={succeeded ? "outline" : "default"}
      disabled={disabled || busy || pending || !data?.configured || !!error}
      onClick={onGenerate}
    >
      {busy
        ? tr("提交中…")
        : pending
          ? insight.state === "queued"
            ? tr("等待生成…")
            : tr("正在生成…")
          : failed
            ? tr("重试")
            : succeeded
              ? tr("重新生成")
              : tr("生成摘要与目录")}
    </Button>
  );
  const notice = (
    <p className="text-xs text-muted-foreground">
      {failed
        ? tr("再次生成会发送转写文本并调用模型，可能重复计费。")
        : tr("转写文本将发送给配置的模型，可能产生费用。")}
      {succeeded && tr("重新生成会替换现有结果。")}
    </p>
  );
  if (!succeeded)
    return (
      <div className="flex flex-col gap-3">
        <ErrorBox message={error} retry={onRefresh} />
        {!error && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>
                {!data
                  ? tr("正在加载")
                  : !data.configured
                    ? tr("请先配置 LLM")
                    : failed
                      ? tr("摘要与目录生成失败")
                      : pending
                        ? generatingTitle
                        : emptyTitle}
              </EmptyTitle>
              <EmptyDescription role="status">
                {!data
                  ? null
                  : !data.configured
                    ? session.user?.role === "admin"
                      ? tr("配置语言模型后即可生成。")
                      : tr("请管理员在服务器设置中配置 LLM 地址和模型。")
                    : failed
                      ? tr(failures[insight.error_code || ""] || "生成失败")
                      : pending
                        ? generatingTitle
                        : view === "summary"
                          ? tr("生成摘要，快速了解录音内容。")
                          : tr("生成主题目录，快速定位录音内容。")}
              </EmptyDescription>
            </EmptyHeader>
            {data?.configured && (
              <EmptyContent>
                {generate}
                {!pending && notice}
              </EmptyContent>
            )}
            {data && !data.configured && session.user?.role === "admin" && (
              <EmptyContent>
                <Button
                  size="sm"
                  variant="outline"
                  nativeButton={false}
                  render={<Link to="/admin/server" />}
                >
                  {tr("配置语言模型")}
                </Button>
              </EmptyContent>
            )}
          </Empty>
        )}
      </div>
    );
  const chapters = (
    <nav
      aria-label={tr("AI 主题目录")}
      className="flex flex-col gap-1"
      title={tr("点击定位当前正文与有效音频时间，不自动播放。")}
    >
      <p className="text-xs font-medium">
        {tr("主题目录")}
        {insight.stale ? tr(" · 已过期") : ""}
      </p>
      {insight.chapters.map((chapter) => (
        <Button
          key={chapter.segment_id}
          variant="ghost"
          className="h-auto min-h-9 w-full items-baseline justify-start gap-2 whitespace-normal px-2 py-1.5 text-left text-[13px] leading-snug"
          onClick={() => onJump(chapter.segment_id)}
        >
          <span className="w-10 shrink-0 text-xs tabular-nums text-muted-foreground">
            {insight.stale
              ? tr("定位")
              : chapter.start_ms === null
                ? tr("无时间")
                : duration(chapter.start_ms)}
          </span>
          <span className="min-w-0 break-words">{chapter.title}</span>
        </Button>
      ))}
    </nav>
  );
  return (
    <div className="flex flex-col gap-4">
      <ErrorBox message={error} retry={onRefresh} />
      {insight.stale && <Badge variant="outline">{tr("转写已更改，结果已过期")}</Badge>}
      {view === "outline" ? (
        chapters
      ) : (
        <>
          <div className="flex flex-col gap-3">
            <p className="line-clamp-3 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
              {insight.summary}
            </p>
            <Button
              variant="link"
              size="sm"
              className="h-auto justify-start self-start p-0"
              onClick={() => setSummaryOpen(true)}
            >
              {tr("查看完整摘要")}
            </Button>
            <p className="text-xs text-muted-foreground">
              {tr("AI 辅助内容，请核对原文 ·")} {insight.model} ·{" "}
              {new Date(insight.updated_at).toLocaleString(interfaceLocale())}
            </p>
            <div className="flex flex-col items-start gap-2">
              {generate}
              {notice}
            </div>
          </div>
        </>
      )}
      <Modal
        title={tr("录音摘要")}
        description={tr("AI 辅助内容，请核对原文")}
        open={summaryOpen}
        onOpenChange={setSummaryOpen}
      >
        <p className="whitespace-pre-wrap break-words text-sm leading-7">{insight.summary}</p>
        <p className="text-xs text-muted-foreground">
          {insight.model} · {new Date(insight.updated_at).toLocaleString(interfaceLocale())}
        </p>
      </Modal>
    </div>
  );
}
