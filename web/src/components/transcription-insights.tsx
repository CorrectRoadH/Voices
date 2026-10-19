// @concord-file
// @concord-implements docs/feature/insights/README.md
// @concord-implements docs/feature/insights/use-case/generate-insights.md
import { tr, interfaceLocale } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { ErrorBox } from "@/components/shared";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
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
export function InsightSummary({
  data,
  error,
  busy,
  disabled,
  onGenerate,
  onRefresh,
}: {
  data: InsightsResponse | null;
  error: string;
  busy: boolean;
  disabled: boolean;
  onGenerate: () => void;
  onRefresh: () => void;
}) {
  const insight = data?.insight;
  const pending = insight?.state === "queued" || insight?.state === "running";
  return (
    <Card className="mb-5">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>{tr("AI 摘要与主题目录")}</CardTitle>
          <Button
            size="sm"
            disabled={disabled || busy || pending || !data?.configured}
            onClick={onGenerate}
          >
            {pending
              ? insight.state === "queued"
                ? tr("等待生成…")
                : tr("正在生成…")
              : busy
                ? tr("提交中…")
                : insight
                  ? tr("重新生成")
                  : tr("生成摘要与目录")}
          </Button>
        </div>
        <CardDescription>{tr("手动生成会把当前版本的转写文本发送到管理员配置的 LLM，可能产生费用。重新生成会替换现有结果。")}{" "}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ErrorBox message={error} retry={onRefresh} />
        {data && !data.configured && (
          <p className="text-sm text-muted-foreground">{tr("请管理员在服务器设置中配置 LLM 地址和模型，并重启服务使其生效。")}{" "}</p>
        )}
        {insight?.stale && <Badge variant="outline">{tr("转写已更改，结果已过期")}</Badge>}
        {insight?.state === "failed" && (
          <p role="status" className="text-sm text-destructive">
            {tr(failures[insight.error_code || ""] || "生成失败")}{tr("。上次请求可能已计费，重新生成会再次调用模型。")}{" "}</p>
        )}
        {insight?.state === "succeeded" ? (
          <>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{insight.summary}</p>
            <p className="text-xs text-muted-foreground">{tr("AI 辅助内容，请核对原文 ·")}{" "}{insight.model} ·{" "}
              {new Date(insight.updated_at).toLocaleString(interfaceLocale())}
            </p>
          </>
        ) : (
          !pending &&
          insight?.state !== "failed" && (
            <p className="text-sm text-muted-foreground">{tr("生成后可阅读摘要，并从主题目录跳转到对应片段。")}{" "}</p>
          )
        )}
      </CardContent>
    </Card>
  );
}
export function InsightOutline({
  insight,
  configured,
  onJump,
}: {
  insight: Schema["TranscriptionInsight"] | null | undefined;
  configured: boolean | undefined;
  onJump: (id: string) => void;
}) {
  if (configured === undefined) return null;
  if (!configured || insight?.state !== "succeeded") {
    const pending = insight?.state === "queued" || insight?.state === "running";
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{!configured ? tr("请先配置 LLM") : pending ? tr("主题目录生成中…") : tr("尚未生成主题目录")}</EmptyTitle>
          <EmptyDescription>
            {!configured
              ? tr("请管理员在服务器设置中配置 LLM 地址和模型，并重启服务使其生效。")
              : pending
                ? tr("生成完成后将在这里显示主题目录。")
                : tr("请在页面上方的“AI 摘要与主题目录”中手动生成。")}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <nav aria-label={tr("AI 主题目录")} className="mb-5 space-y-2">
      <p className="text-xs font-medium">{tr("主题目录")}{insight.stale ? tr(" · 已过期") : ""}</p>
      {insight.chapters.map((chapter) => (
        <Button
          key={chapter.segment_id}
          variant="ghost"
          className="h-auto w-full justify-start gap-3 whitespace-normal py-2 text-left"
          onClick={() => onJump(chapter.segment_id)}
        >
          <span className="shrink-0 text-xs text-muted-foreground">
            {insight.stale
              ? tr("定位")
              : chapter.start_ms === null
                ? tr("无时间")
                : duration(chapter.start_ms)}
          </span>
          <span>{chapter.title}</span>
        </Button>
      ))}
      <p className="text-xs text-muted-foreground">{tr("点击定位当前正文与有效音频时间，不自动播放。")}</p>
    </nav>
  );
}
