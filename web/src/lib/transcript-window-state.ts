// @concord-file
// @concord-implements docs/feature/transcription/use-case/transcribe.md
import type { Schema, Segment, TranscriptionDetail } from "./types";

export type WindowPage = Schema["SegmentList"];
type Direction = "next" | "previous";
export type Load = {
  key: string;
  anchor: string | null;
  cursor: string;
  count: number;
  direction: Direction | null;
  hideBuiltin: boolean;
  version: TranscriptionDetail | null;
};
type Cached = { page: WindowPage; hideBuiltin: boolean };
export type WindowState = {
  key: string;
  status: string | undefined;
  reload: number;
  version: TranscriptionDetail | null;
  segments: WindowPage | null;
  anchor: string | null;
  hideBuiltin: boolean;
  pending: Load | null;
  error: string;
  cache: Cached[];
  edits: Map<string, Segment>;
};
export const emptyWindow: WindowState = {
  key: "",
  status: undefined,
  reload: 0,
  version: null,
  segments: null,
  anchor: null,
  hideBuiltin: false,
  pending: null,
  error: "",
  cache: [],
  edits: new Map(),
};
type Action =
  | {
      type: "sync";
      key: string;
      selected: boolean;
      status: string | undefined;
      reload: number;
      anchor: string | null;
      showBuiltin: boolean;
    }
  | { type: "page"; direction: Direction }
  | { type: "loaded"; load: Load; version: TranscriptionDetail; page: WindowPage }
  | { type: "failed"; load: Load; error: string }
  | { type: "replace"; segment: Segment };
const contains = (page: WindowPage, anchor: string | null) =>
  anchor ? page.items.some((item) => item.id === anchor) : !page.previous_cursor;
// Keep up to four previous contiguous windows, each at most 500 segments. Never
// merge distant pages: their cursors describe different contiguous ranges.
function remember(state: WindowState) {
  if (!state.segments || state.segments.items.length > 500) return state.cache;
  return [
    { page: state.segments, hideBuiltin: state.hideBuiltin },
    ...state.cache.filter((item) => item.page !== state.segments),
  ].slice(0, 4);
}
export function windowReducer(state: WindowState, action: Action): WindowState {
  switch (action.type) {
    case "sync": {
      const same = state.key === action.key;
      const current = same ? state : { ...emptyWindow, key: action.key };
      const refresh =
        !same ||
        action.reload !== current.reload ||
        (action.status !== current.status && action.status !== current.version?.state);
      const next = { ...current, status: action.status, reload: action.reload, error: "" };
      if (!action.selected) return { ...emptyWindow, key: action.key };
      const matches = (page: WindowPage, hideBuiltin: boolean) =>
        contains(page, action.anchor) &&
        (action.anchor !== null || hideBuiltin === !action.showBuiltin);
      if (!refresh && current.version) {
        if (current.segments && matches(current.segments, current.hideBuiltin)) {
          return { ...next, anchor: action.anchor, pending: null };
        }
        const cached = current.cache.find((item) => matches(item.page, item.hideBuiltin));
        if (cached)
          return {
            ...next,
            segments: cached.page,
            hideBuiltin: cached.hideBuiltin,
            anchor: action.anchor,
            pending: null,
            cache: remember(current),
          };
      }
      const keepRange =
        refresh && current.segments && matches(current.segments, current.hideBuiltin);
      const hideBuiltin = keepRange ? current.hideBuiltin : !action.showBuiltin && !action.anchor;
      return {
        ...next,
        cache: refresh ? [] : current.cache,
        pending: {
          key: action.key,
          anchor: action.anchor,
          cursor: keepRange ? current.segments!.current_cursor || "" : "",
          count: keepRange ? current.segments!.items.length : 50,
          direction: null,
          hideBuiltin,
          version: refresh ? null : current.version,
        },
      };
    }
    case "page": {
      if (state.pending || !state.segments || state.error) return state;
      const cursor =
        action.direction === "next" ? state.segments.next_cursor : state.segments.previous_cursor;
      if (!cursor) return state;
      return {
        ...state,
        pending: {
          key: state.key,
          anchor: state.anchor,
          cursor,
          count: 50,
          direction: action.direction,
          hideBuiltin: state.hideBuiltin,
          version: state.version,
        },
      };
    }
    case "loaded": {
      if (state.pending !== action.load) return state;
      let page = action.page;
      if (action.load.direction && state.segments) {
        const items = new Map(state.segments.items.map((item) => [item.id, item]));
        page.items.forEach((item) => items.set(item.id, item));
        page = {
          ...state.segments,
          items: [...items.values()].sort((a, b) => a.ordinal - b.ordinal),
          ...(action.load.direction === "next"
            ? { next_cursor: page.next_cursor }
            : {
                previous_cursor: page.previous_cursor,
                current_cursor: page.current_cursor || action.load.cursor,
              }),
        };
      }
      page = {
        ...page,
        items: page.items.map((item) => {
          const edited = state.edits.get(item.id);
          // Person/label changes do not increment the segment revision. At the
          // same revision the fetched row has the current joined person data.
          return edited && edited.revision > item.revision ? edited : item;
        }),
      };
      return {
        ...state,
        version: action.version,
        segments: page,
        anchor: action.load.anchor,
        hideBuiltin: action.load.hideBuiltin,
        pending: null,
        error: "",
        cache: action.load.direction || !action.load.version ? state.cache : remember(state),
      };
    }
    case "failed":
      return state.pending === action.load
        ? { ...state, pending: null, error: action.error }
        : state;
    case "replace": {
      const patch = (page: WindowPage): WindowPage => ({
        ...page,
        items: page.items.map((item) => (item.id === action.segment.id ? action.segment : item)),
      });
      return {
        ...state,
        edits: new Map(state.edits).set(action.segment.id, action.segment),
        segments: state.segments && patch(state.segments),
        cache: state.cache.map((item) => ({ ...item, page: patch(item.page) })),
      };
    }
  }
}
