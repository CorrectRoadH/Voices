// @concord-file
// @concord-implements docs/feature/transcription/use-case/transcribe.md
import { useEffect, useMemo, useState } from "react";
import { errorMessage } from "./api";
import type { TranscriptStore } from "./transcript-store";
import type { Segment } from "./types";

type SearchLoad = {
  store: TranscriptStore;
  revision: number;
  attempt: number;
} & ({ status: "ready"; items: Segment[] } | { status: "error"; error: string });

export function useTranscriptSearch({
  store,
  revision,
  query,
  anchor,
}: {
  store: TranscriptStore;
  revision: number;
  query: string;
  anchor: string | null;
}) {
  const [load, setLoad] = useState<SearchLoad | null>(null);
  const [attempt, setAttempt] = useState(0);
  const needle = query.trim();
  const enabled = needle.length > 0;
  const result =
    load?.store === store && load.revision === revision && load.attempt === attempt ? load : null;
  const ready = result?.status === "ready";
  useEffect(() => {
    if (!enabled || ready) return;
    setLoad(null);
    const controller = new AbortController();
    void store
      .all(controller.signal)
      .then((items) => {
        if (!controller.signal.aborted)
          setLoad({ store, revision, attempt, status: "ready", items });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setLoad({ store, revision, attempt, status: "error", error: errorMessage(error) });
      });
    return () => controller.abort();
  }, [store, revision, enabled, ready, attempt]);

  const matches = useMemo(() => {
    if (!enabled || result?.status !== "ready") return [];
    const normalized = needle.toLowerCase();
    return result.items.filter((segment) => segment.text.toLowerCase().includes(normalized));
  }, [enabled, result, needle]);
  const currentIndex = matches.findIndex((segment) => segment.id === anchor);
  function adjacentMatch(direction: 1 | -1): string | null {
    if (matches.length === 0) return null;
    if (currentIndex < 0) return matches[direction > 0 ? 0 : matches.length - 1].id;
    return matches[(currentIndex + direction + matches.length) % matches.length].id;
  }
  return {
    status: !enabled ? "idle" : (result?.status ?? "loading"),
    error: enabled && result?.status === "error" ? result.error : "",
    matches,
    count: matches.length,
    currentIndex,
    adjacentMatch,
    retry: () => setAttempt((value) => value + 1),
  };
}
