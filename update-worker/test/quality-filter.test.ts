import { describe, expect, it } from "vite-plus/test";
import { filterQualityItem } from "../src/quality.ts";
const config = { environment: "production", release: "update@quality-test" };
const operations = { "update.request": "http.server", "update.upstream.fetch": "http.client" };
const sentinel = "PRIVATE_SENTINEL";

describe("Worker quality protocol deny boundaries", () => {
  // @concord-implements docs/feature/updates/use-case/check-updates.md
  it("rebuilds a synthetic client_report whitelist without claiming SDK automatic generation", () => {
    expect(
      filterQualityItem(
        "client_report",
        {
          timestamp: 1794800000.1,
          private: sentinel,
          discarded_events: [
            { reason: "before_send", category: "log_item", quantity: 2, private: sentinel },
            { reason: sentinel, category: "error", quantity: 1 },
            { reason: "network_error", category: sentinel, quantity: 1 },
            { reason: "queue_overflow", category: "trace_metric", quantity: 0 },
            { reason: "queue_overflow", category: "trace_metric", quantity: 1.5 },
          ],
        },
        config,
        operations,
      ),
    ).toEqual([
      { type: "client_report" },
      {
        timestamp: 1794800000.1,
        discarded_events: [{ reason: "before_send", category: "log_item", quantity: 2 }],
      },
    ]);
  });
  // @concord-implements docs/feature/updates/use-case/check-updates.md
  it("denies unsupported runtime items, versions and malformed quality payloads independently", () => {
    for (const type of [
      "session",
      "sessions",
      "check_in",
      "profile",
      "profile_chunk",
      "replay_event",
      "replay_recording",
      "attachment",
      "metric",
      "metric_buckets",
      "unknown",
    ])
      expect(
        filterQualityItem(type, { version: 2, items: [sentinel] }, config, operations),
      ).toBeUndefined();
    for (const type of ["log", "trace_metric"])
      for (const payload of [
        null,
        { version: 1, items: [] },
        { version: 2, items: [null, sentinel, { timestamp: -1 }] },
      ])
        expect(filterQualityItem(type, payload, config, operations)).toBeUndefined();
    expect(
      filterQualityItem(
        "client_report",
        { timestamp: Infinity, discarded_events: [] },
        config,
        operations,
      ),
    ).toBeUndefined();
  });
  // @concord-implements docs/feature/updates/use-case/check-updates.md
  it("does not accept subphase counters, arbitrary names, negative values, wrong units or fake service starts", () => {
    const base = {
      timestamp: 1794800000.1,
      trace_id: "11111111111111111111111111111111",
      name: "app.operation.count",
      type: "counter",
      value: 1,
      attributes: {
        operation: { type: "string", value: "update.request" },
        outcome: { type: "string", value: "success" },
      },
    };
    expect(
      filterQualityItem("trace_metric", { version: 2, items: [base] }, config, operations),
    ).toBeDefined();
    for (const item of [
      { ...base, trace_id: "0".repeat(32) },
      { ...base, name: sentinel },
      { ...base, value: 2 },
      { ...base, value: -1 },
      { ...base, name: "app.operation.duration", type: "distribution", unit: "second" },
      {
        ...base,
        attributes: {
          ...base.attributes,
          operation: { type: "string", value: "update.upstream.fetch" },
        },
      },
    ])
      expect(
        filterQualityItem("trace_metric", { version: 2, items: [item] }, config, operations),
      ).toBeUndefined();
    expect(
      filterQualityItem(
        "log",
        { version: 2, items: [{ ...base, body: "service.started", level: "info" }] },
        config,
        operations,
      ),
    ).toBeUndefined();
  });
});
