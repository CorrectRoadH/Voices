// @concord-file
// @concord-implements docs/feature/appearance/README.md
import { useEffect, useRef, useState } from "react";
import { tr } from "./i18n";
import { errorMessage, request } from "./api";
import { useForegroundRefresh } from "./hooks";
import type { Page } from "./types";

type Snapshot<T> = { scope: string; path: string; items: T[]; next_cursor: string | null };
export function usePagedResource<T extends { id: string }>(path: string, scope: string, poll = 0) {
  const [snapshot, setSnapshot] = useState<Snapshot<T>>({
    scope,
    path,
    items: [],
    next_cursor: null,
  });
  const [pending, setPending] = useState<"refresh" | "page" | null>("refresh");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const current = useRef(snapshot);
  current.current = snapshot;
  const active = useRef({ path, scope });
  active.current = { path, scope };
  const valid = snapshot.scope === scope;
  const stale = valid && snapshot.path !== path;
  const items = valid ? snapshot.items : [];

  async function load(more = false) {
    if (
      more &&
      (controller.current || current.current.path !== path || current.current.scope !== scope)
    )
      return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setPending(more ? "page" : "refresh");
    setError("");
    const previous = current.current;
    const same = previous.path === path && previous.scope === scope;
    const target = same ? previous.items.length : 0;
    let cursor = more && same ? previous.next_cursor : null;
    let collected: T[] = [];
    const seen = new Set<string>();
    try {
      do {
        const url = new URL(path, "http://local");
        if (cursor) url.searchParams.set("cursor", cursor);
        const page = await request<Page<T>>(url.pathname + url.search, { signal: abort.signal });
        if (abort.signal.aborted || active.current.path !== path || active.current.scope !== scope)
          return;
        collected = [
          ...collected,
          ...page.items.filter((item) => !collected.some((old) => old.id === item.id)),
        ];
        cursor = page.next_cursor;
        if (cursor && seen.has(cursor))
          throw new Error(tr("服务器返回重复分页游标，请刷新后重试。"));
        if (cursor) seen.add(cursor);
      } while (!more && cursor && collected.length < target);
      const next = {
        scope,
        path,
        items: more
          ? [
              ...previous.items,
              ...collected.filter((item) => !previous.items.some((old) => old.id === item.id)),
            ]
          : collected,
        next_cursor: cursor,
      };
      current.current = next;
      setSnapshot(next);
    } catch (e) {
      if (!abort.signal.aborted) setError(errorMessage(e));
    } finally {
      if (controller.current === abort) {
        controller.current = null;
        setPending(null);
      }
    }
  }
  useEffect(() => {
    void load();
    return () => {
      controller.current?.abort();
      controller.current = null;
    };
  }, [path, scope, revision]);
  useForegroundRefresh(() => {
    if (!controller.current) void load();
  }, poll);
  return {
    items,
    error,
    stale,
    loading: pending !== null,
    updating: pending === "refresh" || (stale && !error),
    nextCursor: valid && !stale ? snapshot.next_cursor : null,
    refresh: () => setRevision((n) => n + 1),
    loadMore: () => void load(true),
  };
}
