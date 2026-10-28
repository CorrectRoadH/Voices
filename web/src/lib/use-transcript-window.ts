// @concord-file
// @concord-implements docs/feature/transcription/use-case/transcribe.md
// @concord-implements docs/feature/sentence-links/use-case/copy-sentence-link.md
import { useEffect, useLayoutEffect, useReducer, useRef, type RefObject } from "react";
import { request, errorMessage } from "./api";
import { validateAnchor } from "./links";
import { tr } from "./i18n";
import { useSegmentFocus } from "./use-segment-focus";
import type { TranscriptStore } from "./transcript-store";
import type { Segment, TranscriptionDetail } from "./types";

import { emptyWindow, windowReducer, type WindowPage } from "./transcript-window-state";

export function useTranscriptWindow({
  store,
  recordingId,
  selected,
  selectedState,
  anchor,
  showBuiltin,
  reload,
  panelRef,
  playerPanelRef,
  queueSeek,
  flushSeek,
}: {
  store: TranscriptStore;
  recordingId: string;
  selected: string | undefined;
  selectedState: string | undefined;
  anchor: string | null;
  showBuiltin: boolean;
  reload: number;
  panelRef: RefObject<HTMLDivElement | null>;
  playerPanelRef: RefObject<HTMLDivElement | null>;
  queueSeek: (time: number | null) => void;
  flushSeek: () => void;
}) {
  const key = JSON.stringify([recordingId, selected, showBuiltin]);
  const [state, dispatch] = useReducer(windowReducer, emptyWindow);
  const topSentinel = useRef<HTMLDivElement>(null);
  const bottomSentinel = useRef<HTMLDivElement>(null);
  const prependAnchor = useRef<{ key: string; id: string; top: number } | null>(null);
  const current = state.key === key;
  const segments = current ? state.segments : null;
  const loading = !!selected && (!current || (!segments && !!state.pending));
  const ready = !!segments && current && state.anchor === anchor;
  const target = ready && anchor ? segments?.items.find((item) => item.id === anchor) : null;
  const viewKey = JSON.stringify([key, anchor]);
  const paging = current ? (state.pending?.direction ?? null) : null;
  const focus = useSegmentFocus({
    anchor,
    viewKey,
    ready,
    panelRef,
    playerPanelRef,
    onPositioned: flushSeek,
  });

  useEffect(() => {
    queueSeek(null);
    dispatch({
      type: "sync",
      key,
      selected: !!selected,
      status: selectedState,
      reload,
      anchor,
      showBuiltin,
    });
  }, [key, selected, selectedState, reload, anchor, showBuiltin, queueSeek]);

  useEffect(() => {
    const load = state.pending;
    if (!load || load.key !== key || load.anchor !== anchor || !selected) return;
    const controller = new AbortController();
    const opts = { signal: controller.signal };
    void (async () => {
      try {
        const version =
          load.version ??
          (await request<TranscriptionDetail>(
            `/transcriptions/${encodeURIComponent(selected)}`,
            opts,
          ));
        validateAnchor(recordingId, selected, version);
        const fetchPage = async (cursor: string, initial = false): Promise<WindowPage> => {
          const page = await store.page(cursor, initial ? load.anchor : null);
          return {
            ...page,
            items: load.hideBuiltin
              ? page.items.filter((item) => !item.person_builtin_key)
              : page.items,
          };
        };
        let page = await fetchPage(load.cursor, !load.direction);
        if (!load.direction) {
          const seen = new Set<string>();
          while (page.next_cursor && page.items.length < load.count) {
            if (controller.signal.aborted) return;
            if (seen.has(page.next_cursor))
              throw new Error(tr("服务器返回重复分页游标，请刷新后重试。"));
            seen.add(page.next_cursor);
            const next = await fetchPage(page.next_cursor);
            page = {
              ...page,
              items: [...page.items, ...next.items],
              next_cursor: next.next_cursor,
            };
          }
        }
        page.items.forEach((segment) => validateAnchor(recordingId, selected, version, segment));
        if (
          !load.direction &&
          load.anchor &&
          !page.items.some((segment) => segment.id === load.anchor)
        )
          throw new Error(tr("服务器返回的窗口未包含引用片段，无法定位。"));
        if (controller.signal.aborted) return;
        if (load.direction === "previous") {
          const first = panelRef.current?.querySelector<HTMLElement>(".segments > article");
          if (first)
            prependAnchor.current = { key, id: first.id, top: first.getBoundingClientRect().top };
        }
        dispatch({ type: "loaded", load, version, page });
      } catch (error) {
        if (!controller.signal.aborted)
          dispatch({ type: "failed", load, error: errorMessage(error) });
      }
    })();
    return () => controller.abort();
  }, [state.pending, key, selected, recordingId, anchor, panelRef, store]);

  useLayoutEffect(() => {
    if (!ready || !anchor) return;
    if (
      target &&
      target.start_ms !== null &&
      target.end_ms !== null &&
      target.end_ms > target.start_ms
    )
      queueSeek(target.start_ms);
  }, [ready, viewKey, anchor, target?.start_ms, target?.end_ms, queueSeek]);

  useLayoutEffect(() => {
    const previous = prependAnchor.current;
    prependAnchor.current = null;
    if (!previous || previous.key !== key) return;
    const panel = panelRef.current;
    const element = panel?.querySelector<HTMLElement>(`#${CSS.escape(previous.id)}`);
    if (!element) return;
    const delta = element.getBoundingClientRect().top - previous.top;
    if (panel && getComputedStyle(panel).overflowY === "auto") panel.scrollTop += delta;
    else window.scrollBy(0, delta);
  }, [segments, key, panelRef]);

  useEffect(() => {
    if (!segments || state.pending || state.error || !focus.positioned || state.anchor !== anchor)
      return;
    const panel = panelRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const direction = entry.target === topSentinel.current ? "previous" : "next";
          if (!(direction === "next" ? segments.next_cursor : segments.previous_cursor)) continue;
          dispatch({ type: "page", direction });
          break;
        }
      },
      {
        root: panel && getComputedStyle(panel).overflowY === "auto" ? panel : null,
        rootMargin: "150px",
      },
    );
    if (topSentinel.current) observer.observe(topSentinel.current);
    if (bottomSentinel.current) observer.observe(bottomSentinel.current);
    return () => observer.disconnect();
  }, [segments, state.pending, state.error, focus.positioned, panelRef, state.anchor, anchor]);

  return {
    target,
    version: current ? state.version : null,
    segments,
    loading,
    paging,
    pendingAnchor:
      current && state.pending && !state.pending.direction ? state.pending.anchor : null,
    loadError: current ? state.error : "",
    topSentinel,
    bottomSentinel,
    position: focus.position,
    replaceSegment: (segment: Segment) => {
      store.replace(segment);
      dispatch({ type: "replace", segment });
    },
  };
}
