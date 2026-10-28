// @concord-file
// @concord-implements docs/feature/transcription/use-case/transcribe.md
import { useEffect, useMemo, useRef, useState } from "react";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { tr } from "@/lib/i18n";
import { segmentSpeakerName } from "@/lib/person-name";
import { duration } from "@/lib/format";
import type { Segment } from "@/lib/types";
import type { TranscriptStore } from "@/lib/transcript-store";
import { useTranscriptSearch } from "@/lib/use-transcript-search";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Field, FieldLabel } from "./ui/field";
import { ErrorBox } from "./shared";
import { HighlightedText } from "./highlighted-text";

function excerpt(text: string, query: string) {
  const index = text.toLowerCase().indexOf(query.trim().toLowerCase());
  const start = Math.max(0, index - 45);
  const end = Math.min(text.length, Math.max(index, 0) + query.trim().length + 90);
  return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export function TranscriptSearch({
  store,
  revision,
  query,
  onQuery,
  anchor,
  onJump,
}: {
  store: TranscriptStore;
  revision: number;
  query: string;
  onQuery: (query: string) => void;
  anchor: string | null;
  onJump: (id: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(query);
  const [composing, setComposing] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState<Segment>();
  const [limit, setLimit] = useState(30);
  useEffect(() => {
    if (composing) return;
    const timer = setTimeout(() => onQuery(draft), draft ? 150 : 0);
    return () => clearTimeout(timer);
  }, [draft, composing, onQuery]);
  const search = useTranscriptSearch({ store, revision, query, anchor });
  const stale = composing || draft !== query;
  const items = useMemo(() => search.matches.slice(0, limit), [search.matches, limit]);
  const choose = (id: string) => {
    setOpen(false);
    onJump(id);
  };
  const jump = (direction: 1 | -1) => {
    if (stale) return;
    const id = search.adjacentMatch(direction);
    if (id !== null) choose(id);
  };
  const clear = () => {
    setDraft("");
    onQuery("");
    setOpen(false);
  };
  function statusMessage() {
    if (stale || search.status === "loading") return tr("正在搜索…");
    if (search.status === "error") return tr("搜索失败");
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
          <Autocomplete.Root
            items={items}
            mode="none"
            value={draft}
            onValueChange={(value, details) => {
              if (details.reason === "item-press") return;
              setDraft(value);
              setLimit(30);
            }}
            open={open}
            onOpenChange={setOpen}
            openOnInputClick
            onItemHighlighted={setHighlighted}
            itemToStringValue={(item: Segment) => item.text}
          >
            <Autocomplete.Input
              ref={inputRef}
              id="transcript-search"
              aria-label={tr("搜索转写正文")}
              type="search"
              placeholder={tr("搜索转写正文…")}
              render={<Input />}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || composing) {
                  event.preventBaseUIHandler();
                  return;
                }
                if (event.key === "Escape" && !open) {
                  event.preventDefault();
                  clear();
                }
                if (event.key === "Enter" && (event.shiftKey || !open || !highlighted)) {
                  event.preventDefault();
                  event.stopPropagation();
                  event.preventBaseUIHandler();
                  jump(event.shiftKey ? -1 : 1);
                }
              }}
            />
            {!!draft.trim() && search.count > 0 && (
              <Autocomplete.Portal>
                <Autocomplete.Positioner sideOffset={4} className="outline-none">
                  <Autocomplete.Popup className="w-[var(--anchor-width)] max-w-[var(--available-width)] rounded-lg border bg-popover text-popover-foreground shadow-md">
                    {stale && (
                      <span role="status" className="block px-3 py-2 text-xs text-muted-foreground">
                        {tr("正在搜索…")}
                      </span>
                    )}
                    <Autocomplete.List className="max-h-[min(20rem,var(--available-height))] overflow-y-auto p-1">
                      {(segment: Segment) => (
                        <Autocomplete.Item
                          key={segment.id}
                          value={segment}
                          disabled={stale}
                          onClick={() => choose(segment.id)}
                          className="flex cursor-default flex-col gap-1 rounded-md px-3 py-2 text-sm break-words outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                        >
                          <span className="text-xs text-muted-foreground">
                            {duration(segment.start_ms)} · {segmentSpeakerName(segment)}
                          </span>
                          <span>
                            <HighlightedText text={excerpt(segment.text, query)} query={query} />
                          </span>
                        </Autocomplete.Item>
                      )}
                    </Autocomplete.List>
                    {search.count > limit && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setLimit((value) => value + 30);
                          inputRef.current?.focus();
                        }}
                      >
                        {tr("显示更多结果")}
                      </Button>
                    )}
                  </Autocomplete.Popup>
                </Autocomplete.Positioner>
              </Autocomplete.Portal>
            )}
          </Autocomplete.Root>
        </Field>
        {(draft || search.status !== "idle") && (
          <>
            <span role="status" className="text-xs text-muted-foreground">
              {statusMessage()}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tr("上一个匹配片段")}
              disabled={stale || search.count === 0}
              onClick={() => jump(-1)}
            >
              <ArrowUp />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tr("下一个匹配片段")}
              disabled={stale || search.count === 0}
              onClick={() => jump(1)}
            >
              <ArrowDown />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={tr("清除正文搜索")} onClick={clear}>
              <X />
            </Button>
          </>
        )}
      </div>
      <ErrorBox message={search.error} retry={search.retry} />
    </div>
  );
}
