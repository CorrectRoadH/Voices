// @concord-file
// @concord-implements docs/feature/call-logs/use-case/inspect-calls.md
import type { Schema } from "./types";
type Call = Schema["ExternalCall"];
export function groupCalls(items: Call[]): Call[][] {
  const groups: Call[][] = [];
  for (const call of items) {
    const previous = groups.at(-1)?.[0];
    if (
      call.operation === "poll" &&
      call.state === "succeeded" &&
      call.job_id &&
      previous?.operation === "poll" &&
      previous.state === "succeeded" &&
      ["job_id", "transcription_id", "provider", "model", "recording_id"].every(
        (key) => call[key as keyof Call] === previous[key as keyof Call],
      )
    ) {
      groups[groups.length - 1].push(call);
    } else groups.push([call]);
  }
  return groups;
}
