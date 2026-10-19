// @concord-file
// @concord-implements docs/feature/transcription/use-case/transcribe.md
import { tr } from "@/lib/i18n";
import type { Segment } from "@/lib/types";
import { duration } from "@/lib/format";

export function TranscriptOutline({ segments, onJump }: { segments: Segment[]; onJump?: () => void }) {
  const seen = new Set<number>();
  const entries = segments.filter((segment, index) => {
    const bucket = segment.start_ms === null ? -1 - Math.floor(index / 50) : Math.floor(segment.start_ms / 60000);
    if (seen.has(bucket)) return false;
    seen.add(bucket);
    return true;
  });
  return <nav aria-label={tr("转写时间目录")} className="transcript-outline">
    <p className="text-xs text-muted-foreground">{tr("已加载正文 · 随滚动加载更新")}</p>
    {entries.length ? entries.map((segment) => <a key={segment.id} href={`#segment-${segment.id}`} className="outline-entry" onClick={(event) => {
      event.preventDefault();
      onJump?.();
      requestAnimationFrame(() => document.getElementById(`segment-${segment.id}`)?.scrollIntoView({block:"center", behavior:"instant"}));
    }}><span className="outline-time">{segment.start_ms === null ? tr("片段 {{v0}}", { v0: segment.ordinal + 1 }) : duration(segment.start_ms)}</span><span className="truncate">{segment.text || tr("（空白片段）")}</span></a>) : <p className="text-xs text-muted-foreground">{tr("加载正文后显示目录")}</p>}
  </nav>;
}
