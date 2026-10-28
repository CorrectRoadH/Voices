// @concord-file
// @concord-implements docs/feature/transcription/architecture.md
import { request } from "./api";
import { tr } from "./i18n";
import type { Segment } from "./types";
import type { WindowPage } from "./transcript-window-state";

type StoredPage = Omit<WindowPage, "items"> & { ids: string[] };

/** One reading session owns raw pages, entities and shared requests. */
export class TranscriptStore {
  private entities = new Map<string, Segment>();
  private pages = new Map<string, StoredPage>();
  private pending = new Map<string, Promise<StoredPage>>();
  private controller = new AbortController();
  private generation = 0;

  constructor(readonly transcriptionId: string) {}

  dispose() {
    this.controller.abort();
    this.controller = new AbortController();
    this.generation++;
    this.pending.clear();
    this.pages.clear();
    this.entities.clear();
  }

  replace(segment: Segment) {
    if (segment.transcription_id !== this.transcriptionId) return;
    const previous = this.entities.get(segment.id);
    if (!previous || previous.revision <= segment.revision) this.entities.set(segment.id, segment);
  }

  private materialize(page: StoredPage): WindowPage {
    const { ids, ...cursors } = page;
    return { ...cursors, items: ids.map((id) => this.entities.get(id)!) };
  }

  async page(cursor = "", anchor: string | null = null): Promise<WindowPage> {
    const key = cursor ? `cursor:${cursor}` : anchor ? `anchor:${anchor}` : "first";
    const cached =
      this.pages.get(key) ??
      (!cursor && anchor
        ? [...this.pages.values()].find((page) => page.ids.includes(anchor))
        : undefined);
    if (cached) return this.materialize(cached);
    let pending = this.pending.get(key);
    if (!pending) {
      const generation = this.generation;
      const signal = this.controller.signal;
      const params = new URLSearchParams({ limit: "50", hide_builtin: "false" });
      if (cursor) params.set("cursor", cursor);
      else if (anchor) params.set("anchor_id", anchor);
      pending = request<WindowPage>(
        `/transcriptions/${encodeURIComponent(this.transcriptionId)}/segments?${params}`,
        { signal },
      )
        .then((page) => {
          if (generation !== this.generation || signal.aborted)
            throw new DOMException("Aborted", "AbortError");
          if (page.items.some((item) => item.transcription_id !== this.transcriptionId))
            throw new Error(tr("该引用的录音、转写版本与片段不匹配，无法打开。"));
          page.items.forEach((item) => this.replace(item));
          const { items, ...cursors } = page;
          const stored = { ...cursors, ids: items.map((item) => item.id) };
          this.pages.set(key, stored);
          if (page.current_cursor) this.pages.set(`cursor:${page.current_cursor}`, stored);
          if (!page.previous_cursor) this.pages.set("first", stored);
          return stored;
        })
        .finally(() => {
          if (generation === this.generation) this.pending.delete(key);
        });
      this.pending.set(key, pending);
    }
    return this.materialize(await pending);
  }

  async all(signal: AbortSignal): Promise<Segment[]> {
    const generation = this.generation;
    const ids = new Set<string>();
    const seen = new Set<string>();
    let cursor = "";
    do {
      signal.throwIfAborted();
      const page = await this.page(cursor);
      signal.throwIfAborted();
      if (generation !== this.generation) throw new DOMException("Aborted", "AbortError");
      page.items.forEach((item) => ids.add(item.id));
      cursor = page.next_cursor || "";
      if (cursor && seen.has(cursor)) throw new Error(tr("服务器返回重复分页游标，请刷新后重试。"));
      seen.add(cursor);
    } while (cursor);
    return [...ids].map((id) => this.entities.get(id)!);
  }
}
