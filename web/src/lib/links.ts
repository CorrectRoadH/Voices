// @concord-file
// @concord-implements docs/feature/sentence-links/use-case/copy-sentence-link.md
import { tr } from "@/lib/i18n";
import type { Segment, TranscriptionDetail } from "./types";

export function basePath(value: string) {
  const pathname = new URL(value || "/", "http://localhost").pathname;
  return pathname.replace(/\/$/, "");
}
export function safeReturnPath(candidate: string, base = "") {
  if (!candidate.startsWith("/") || candidate.startsWith("//") || /[\\\r\n]/.test(candidate))
    return `${base}/recordings`;
  const url = new URL(candidate, "https://voices.invalid");
  if (
    url.origin !== "https://voices.invalid" ||
    (base && url.pathname !== base && !url.pathname.startsWith(`${base}/`))
  )
    return `${base}/recordings`;
  return `${url.pathname}${url.search}${url.hash}`;
}
export function sentenceUrl(publicBase: string, segment: Segment, origin: string) {
  const base = new URL(publicBase || "/", origin);
  base.pathname = `${base.pathname.replace(/\/$/, "")}/recordings/${encodeURIComponent(segment.recording_id)}/transcriptions/${encodeURIComponent(segment.transcription_id)}`;
  base.search = new URLSearchParams({ segment: segment.id }).toString();
  base.hash = "";
  return base.toString();
}
export function escapeMarkdown(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/[\r\n]+/g, " ");
}
export function sentenceMarkdown(publicBase: string, segment: Segment, origin: string) {
  return `[${escapeMarkdown(segment.speaker_name || tr("未知说话人"))}: ${escapeMarkdown(segment.text)}](${sentenceUrl(publicBase, segment, origin)})`;
}
export function validateAnchor(
  recordingId: string,
  transcriptionId: string,
  version: TranscriptionDetail,
  segment?: Segment,
) {
  if (
    version.id !== transcriptionId ||
    version.recording_id !== recordingId ||
    (segment &&
      (segment.recording_id !== recordingId || segment.transcription_id !== transcriptionId))
  ) {
    throw new Error(tr("该引用的录音、转写版本与片段不匹配，无法打开。"));
  }
}
export async function copyText(text: string, clipboard = globalThis.navigator?.clipboard) {
  if (!clipboard?.writeText) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
