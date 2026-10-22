// @concord-file
// @concord-implements docs/feature/transcription/use-case/transcribe.md
import { useEffect, useMemo, useState } from "react";
import { errorMessage, requestAll } from "./api";
import type { Segment } from "./types";

type SearchLoad =
  | { key: string; status: "ready"; items: Segment[] }
  | { key: string; status: "error"; error: string };

export function useTranscriptSearch({
  transcriptionId,
  revision,
  query,
  anchor,
}: {
  transcriptionId: string;
  revision: number;
  query: string;
  anchor: string | null;
}) {
  const [load, setLoad] = useState<SearchLoad | null>(null);
  const [attempt, setAttempt] = useState(0);
  const needle = query.trim();
  const enabled = needle.length > 0;
  const key = JSON.stringify([transcriptionId, revision, attempt, enabled]);

  useEffect(() => {
    setLoad(null);
    if (!enabled) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void requestAll<Segment>(
        `/transcriptions/${encodeURIComponent(transcriptionId)}/segments?limit=100&hide_builtin=false`,
        controller.signal,
      )
        .then((page) => {
          if (!controller.signal.aborted) setLoad({ key, status: "ready", items: page.items });
        })
        .catch((error) => {
          if (!controller.signal.aborted)
            setLoad({ key, status: "error", error: errorMessage(error) });
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [transcriptionId, enabled, key]);

  const result = load?.key === key ? load : null;
  const matches = useMemo(() => {
    if (!enabled || result?.status !== "ready") return [];
    const normalized = needle.toLowerCase();
    return result.items.filter((segment) => segment.text.toLowerCase().includes(normalized));
  }, [enabled, result, needle]);
  const currentIndex = matches.findIndex((segment) => segment.id === anchor);
  function adjacentMatch(direction: 1 | -1): string | null {
    if (matches.length === 0) return null;
    if (currentIndex < 0) return matches[direction > 0 ? 0 : matches.length - 1].id;
    const next = (currentIndex + direction + matches.length) % matches.length;
    return matches[next].id;
  }
  const status = !enabled ? "idle" : (result?.status ?? "loading");
  return {
    status,
    error: result?.status === "error" ? result.error : "",
    count: matches.length,
    currentIndex,
    adjacentMatch,
    retry: () => setAttempt((value) => value + 1),
  };
}
