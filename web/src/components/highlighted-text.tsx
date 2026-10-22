// @concord-file
// @concord-implements docs/feature/transcription/use-case/transcribe.md
export function HighlightedText({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) return text;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.split(new RegExp(`(${escaped})`, "gi")).map((part, index) =>
    index % 2 ? (
      <mark key={index} className="transcript-match">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}
