// @concord-file
// @concord-implements docs/feature/transcription/use-case/transcribe.md
// @concord-implements docs/feature/sentence-links/use-case/copy-sentence-link.md
import { useEffect, useLayoutEffect, useReducer, useRef, type RefObject } from "react";
import { request, errorMessage } from "./api";
import { validateAnchor } from "./links";
import { tr } from "./i18n";
import { useSegmentFocus } from "./use-segment-focus";
import type { Schema, Segment, TranscriptionDetail } from "./types";

type Direction = "next" | "previous";
type WindowPage = Schema["SegmentList"];
type Load = {
  key: string;
  cursor: string;
  count: number;
  direction: Direction | null;
  initial: boolean;
};
type State = {
  key: string;
  version: TranscriptionDetail | null;
  segments: WindowPage | null;
  pending: Load | null;
  error: string;
};
type Action =
  | { type: "refresh"; key: string; selected: boolean }
  | { type: "page"; direction: Direction }
  | { type: "loaded"; load: Load; version: TranscriptionDetail; page: WindowPage }
  | { type: "failed"; load: Load; error: string }
  | { type: "replace"; segment: Segment };
const empty: State = { key: "", version: null, segments: null, pending: null, error: "" };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "refresh": {
      const initial = state.key !== action.key || !state.segments;
      const current = initial ? { ...empty, key: action.key } : state;
      return {
        ...current,
        error: "",
        pending: action.selected
          ? {
              key: action.key,
              cursor: current.segments?.current_cursor || "",
              count: current.segments?.items.length || 50,
              direction: null,
              initial,
            }
          : null,
      };
    }
    case "page": {
      if (state.pending || !state.segments || state.error) return state;
      const cursor =
        action.direction === "next" ? state.segments.next_cursor : state.segments.previous_cursor;
      if (!cursor) return state;
      return {
        ...state,
        pending: { key: state.key, cursor, count: 50, direction: action.direction, initial: false },
      };
    }
    case "loaded": {
      if (state.pending !== action.load) return state;
      let segments = action.page;
      if (action.load.direction && state.segments) {
        const unique = new Map(state.segments.items.map((item) => [item.id, item]));
        action.page.items.forEach((item) => unique.set(item.id, item));
        segments = {
          ...state.segments,
          items: [...unique.values()].sort((a, b) => a.ordinal - b.ordinal),
          ...(action.load.direction === "next"
            ? { next_cursor: action.page.next_cursor }
            : {
                previous_cursor: action.page.previous_cursor,
                current_cursor: action.page.current_cursor || action.load.cursor,
              }),
        };
      }
      return { ...state, version: action.version, segments, pending: null, error: "" };
    }
    case "failed":
      return state.pending === action.load
        ? { ...state, pending: null, error: action.error }
        : state;
    case "replace":
      return {
        ...state,
        segments: state.segments && {
          ...state.segments,
          items: state.segments.items.map((item) =>
            item.id === action.segment.id ? action.segment : item,
          ),
        },
      };
  }
}

export function useTranscriptWindow({
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
  const key = JSON.stringify([recordingId, selected, anchor, showBuiltin]);
  const [state, dispatch] = useReducer(reducer, empty);
  const topSentinel = useRef<HTMLDivElement>(null);
  const bottomSentinel = useRef<HTMLDivElement>(null);
  const prependAnchor = useRef<{ key: string; id: string; top: number } | null>(null);
  const current = state.key === key;
  const segments = current ? state.segments : null;
  const loading = !!selected && (!current || !!state.pending?.initial);
  const paging = current ? (state.pending?.direction ?? null) : null;
  const focus = useSegmentFocus({
    anchor,
    viewKey: key,
    ready: !!segments && !loading,
    panelRef,
    playerPanelRef,
    onPositioned: flushSeek,
  });

  useEffect(() => {
    queueSeek(null);
    dispatch({ type: "refresh", key, selected: !!selected });
  }, [key, selected, selectedState, reload, queueSeek]);

  useEffect(() => {
    const load = state.pending;
    if (!load || load.key !== key || !selected) return;
    const controller = new AbortController();
    const opts = { signal: controller.signal };
    void (async () => {
      try {
        const version = await request<TranscriptionDetail>(
          `/transcriptions/${encodeURIComponent(selected)}`,
          opts,
        );
        const target = anchor
          ? await request<Segment>(`/segments/${encodeURIComponent(anchor)}`, opts)
          : undefined;
        validateAnchor(recordingId, selected, version, target);
        const fetchPage = (cursor: string, initial = false) =>
          request<WindowPage>(
            `/transcriptions/${encodeURIComponent(selected)}/segments?limit=50&hide_builtin=${!showBuiltin && !anchor}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : initial && anchor ? `&anchor_id=${encodeURIComponent(anchor)}` : ""}`,
            opts,
          );
        let page = await fetchPage(load.cursor, load.initial);
        if (!load.direction) {
          while (page.next_cursor && page.items.length < load.count) {
            const next = await fetchPage(page.next_cursor);
            page = {
              ...page,
              items: [...page.items, ...next.items],
              next_cursor: next.next_cursor,
            };
          }
        }
        page.items.forEach((segment) => validateAnchor(recordingId, selected, version, segment));
        if (load.initial && anchor && !page.items.some((segment) => segment.id === anchor))
          throw new Error(tr("服务器返回的窗口未包含引用片段，无法定位。"));
        if (controller.signal.aborted) return;
        if (load.direction === "previous") {
          const first = panelRef.current?.querySelector<HTMLElement>(".segments > article");
          if (first)
            prependAnchor.current = { key, id: first.id, top: first.getBoundingClientRect().top };
        }
        if (
          load.initial &&
          target &&
          target.start_ms !== null &&
          target.end_ms !== null &&
          target.end_ms > target.start_ms
        )
          queueSeek(target.start_ms);
        dispatch({ type: "loaded", load, version, page });
      } catch (error) {
        if (!controller.signal.aborted)
          dispatch({ type: "failed", load, error: errorMessage(error) });
      }
    })();
    return () => controller.abort();
  }, [state.pending, key, selected, recordingId, anchor, showBuiltin, panelRef, queueSeek]);

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
    if (!segments || state.pending || state.error || !focus.positioned) return;
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
  }, [segments, state.pending, state.error, focus.positioned, panelRef]);

  return {
    version: current ? state.version : null,
    segments,
    loading,
    paging,
    loadError: current ? state.error : "",
    topSentinel,
    bottomSentinel,
    position: focus.position,
    replaceSegment: (segment: Segment) => dispatch({ type: "replace", segment }),
  };
}
