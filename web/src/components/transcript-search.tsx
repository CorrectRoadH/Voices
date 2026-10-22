// @concord-file
// @concord-implements docs/feature/transcription/use-case/transcribe.md
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { tr } from "@/lib/i18n";
import { useTranscriptSearch } from "@/lib/use-transcript-search";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Field, FieldLabel } from "./ui/field";
import { ErrorBox } from "./shared";

export function TranscriptSearch({
  transcriptionId,
  revision,
  query,
  onQuery,
  anchor,
  onJump,
}: {
  transcriptionId: string;
  revision: number;
  query: string;
  onQuery: (query: string) => void;
  anchor: string | null;
  onJump: (id: string) => void;
}) {
  const search = useTranscriptSearch({ transcriptionId, revision, query, anchor });
  const jump = (direction: 1 | -1) => {
    const id = search.adjacentMatch(direction);
    if (id !== null) onJump(id);
  };
  function statusMessage() {
    if (search.status === "error") return tr("搜索失败");
    if (search.status === "loading") return tr("正在搜索…");
    if (search.count === 0) return tr("没有匹配片段");
    if (search.currentIndex < 0) return tr("{{count}} 个匹配片段", { count: search.count });
    return `${search.currentIndex + 1} / ${search.count}`;
  }
  return (
    <div className="transcript-search">
      <div className="flex flex-wrap items-center gap-2">
        <Field className="min-w-32 flex-1">
          <FieldLabel className="sr-only" htmlFor="transcript-search">
            {tr("搜索转写正文")}
          </FieldLabel>
          <Input
            id="transcript-search"
            type="search"
            placeholder={tr("搜索转写正文…")}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Escape") {
                event.preventDefault();
                onQuery("");
              }
              if (event.key === "Enter") {
                event.preventDefault();
                jump(event.shiftKey ? -1 : 1);
              }
            }}
          />
        </Field>
        {search.status !== "idle" && (
          <>
            <span role="status" className="text-xs text-muted-foreground">
              {statusMessage()}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tr("上一个匹配片段")}
              disabled={search.count === 0}
              onClick={() => jump(-1)}
            >
              <ArrowUp />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tr("下一个匹配片段")}
              disabled={search.count === 0}
              onClick={() => jump(1)}
            >
              <ArrowDown />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tr("清除正文搜索")}
              onClick={() => onQuery("")}
            >
              <X />
            </Button>
          </>
        )}
      </div>
      <ErrorBox message={search.error} retry={search.retry} />
    </div>
  );
}
