// @concord-file
// @concord-implements docs/feature/people/use-case/recognize-speaker.md
import { useEffect, useRef } from "react";
import { useForegroundRefresh, useResource } from "./hooks";
import type { Schema } from "./types";

// Observe publication without exposing model maintenance as a user task.
export function useVoiceprintPublication(
  id: string | undefined,
  revision: number,
  onPublished: () => void,
) {
  const data = useResource<Schema["TranscriptionVoiceprints"]>(
    id ? `/transcriptions/${encodeURIComponent(id)}/voiceprints` : null,
    revision,
  );
  const task = data.data?.task;
  const busy = task?.state === "queued" || task?.state === "running";
  const retrying =
    task?.state === "failed" &&
    ["inference_unavailable", "interrupted", "processing_failed"].includes(task.error_code ?? "");
  useForegroundRefresh(
    () => {
      if (!data.refreshing) data.refresh();
    },
    busy ? 5000 : retrying ? 30000 : 0,
  );
  const seen = useRef("");
  const published = useRef(onPublished);
  published.current = onPublished;
  useEffect(() => {
    const task = data.data?.task;
    if (!id || task?.state !== "succeeded") return;
    const key = `${id}:${task.generation}:${task.updated_at}`;
    if (seen.current === key) return;
    seen.current = key;
    published.current();
  }, [id, data.data]);
}
