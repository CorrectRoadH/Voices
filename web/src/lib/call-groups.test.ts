import { describe, expect, it } from "vite-plus/test";
import { groupCalls } from "./call-groups";
import type { Schema } from "./types";
type Call = Schema["ExternalCall"];
const call = (id: string, patch: Partial<Call> = {}): Call => ({
  id,
  category: "stt",
  operation: "poll",
  state: "succeeded",
  provider: "soniox",
  model: "stt",
  job_id: "job",
  transcription_id: "version",
  recording_id: "recording",
  operation_id: null,
  generation: null,
  started_at: "2026-10-23T00:00:00Z",
  finished_at: null,
  error_code: null,
  error_reason: null,
  duration_ms: 200,
  http_status: 200,
  audio_duration_ms: 5162000,
  input_tokens: null,
  output_tokens: null,
  total_tokens: null,
  request_started: true,
  recording_available: true,
  can_open_recording: true,
  actor: null,
  ...patch,
});
// @use-case docs/feature/call-logs/use-case/inspect-calls.md
describe("loaded call groups", () => {
  it("preserves every record and never folds across an error or a different task", () => {
    const items = [
      call("1"),
      call("2"),
      call("3", { state: "failed" }),
      call("4"),
      call("5", { job_id: "other" }),
      call("6", { job_id: "other" }),
    ];
    const groups = groupCalls(items);
    expect(groups.map((g) => g.map((c) => c.id))).toEqual([["1", "2"], ["3"], ["4"], ["5", "6"]]);
    expect(groups.flat()).toEqual(items);
  });
  it("extends the loaded group on pagination without inventing totals or summing usage", () => {
    const first = [call("1"), call("2")];
    expect(groupCalls(first)[0]).toHaveLength(2);
    expect(groupCalls([...first, call("3")])[0]).toHaveLength(3);
    expect(first[0].audio_duration_ms).toBe(5162000);
  });
  it("keeps unrelated, uncertain and unassociated operations separate", () => {
    for (const patch of [{ job_id: null }, { state: "uncertain" }, { operation: "upload" }])
      expect(groupCalls([call("1", patch), call("2", patch)])).toHaveLength(2);
    expect(groupCalls([call("1"), call("2", { transcription_id: "other" })])).toHaveLength(2);
    expect(groupCalls([])).toEqual([]);
  });
});
