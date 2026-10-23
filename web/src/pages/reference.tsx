// @concord-file
// @concord-implements docs/feature/sentence-links/use-case/copy-sentence-link.md#open
import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { ErrorBox, Loading } from "@/components/shared";
import { useResource } from "@/lib/hooks";
import { tr } from "@/lib/i18n";
import type { Schema } from "@/lib/types";

export function ReferencePage() {
  const { code = "" } = useParams();
  const [search] = useSearchParams();
  const reference = useResource<Schema["TranscriptReference"]>(
    `/references/${encodeURIComponent(code)}`,
  );
  if (reference.error) return <ErrorBox message={reference.error} retry={reference.refresh} />;
  if (!reference.data || reference.data.code !== code) return <Loading />;
  const at = search.get("at") ?? "1";
  const index = /^[1-9]\d*$/.test(at) ? Number(at) - 1 : -1;
  const segment = reference.data.segments[index];
  if (!segment) return <ErrorBox message={tr("引用位置无效，无法定位。")} />;
  const query = new URLSearchParams({ ref: code, segment: segment.id });
  return (
    <Navigate
      replace
      to={`/recordings/${reference.data.recording_id}/transcriptions/${reference.data.transcription_id}?${query}`}
    />
  );
}
