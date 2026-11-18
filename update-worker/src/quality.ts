// @concord-file
// @concord-implements docs/feature/updates/use-case/check-updates.md
import { logger, metrics, SDK_VERSION, type Log, type Metric } from "@sentry/cloudflare";

import type { Operation } from "./telemetry.ts";

type Config = { environment: string; release?: string };
type Operations = Readonly<Record<string, string>>;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const id = (value: unknown, length: number): value is string =>
  typeof value === "string" &&
  value.length === length &&
  /^[a-f0-9]+$/.test(value) &&
  !/^0+$/.test(value);
const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const outcomes = ["success", "error", "cancelled", "rejected"];
const messages = { "operation.failed": "error", "operation.degraded": "warn" } as const;
const metricKinds = {
  "app.operation.count": "counter",
  "app.operation.duration": "distribution",
} as const;
// Exact core@11.13.0 EventDropReason/DataCategory unions. No free-text escape hatch.
const reasons = new Set([
  "before_send",
  "callback_error",
  "event_processor",
  "network_error",
  "queue_overflow",
  "ratelimit_backoff",
  "sample_rate",
  "send_error",
  "internal_sdk_error",
  "buffer_overflow",
  "ignored",
  "invalid",
  "no_parent_span",
]);
const categories = new Set([
  "default",
  "error",
  "transaction",
  "replay",
  "security",
  "attachment",
  "session",
  "internal",
  "profile",
  "monitor",
  "feedback",
  "span",
  "log_item",
  "log_byte",
  "trace_metric",
  "unknown",
]);

function attributes(input: unknown, config: Config, operations: Operations) {
  const raw = record(input) ?? {};
  const output: Record<string, string | number> = {
    component: "update",
    environment: config.environment,
    "sentry.environment": config.environment,
    "sentry.sdk.name": "sentry.javascript.cloudflare",
    "sentry.sdk.version": SDK_VERSION,
  };
  if (config.release) {
    output.release = config.release;
    output["sentry.release"] = config.release;
  }
  if (typeof raw.operation === "string" && Object.hasOwn(operations, raw.operation))
    output.operation = raw.operation;
  if (typeof raw.outcome === "string" && outcomes.includes(raw.outcome))
    output.outcome = raw.outcome;
  if (nonnegative(raw.duration_ms)) output.duration_ms = raw.duration_ms;
  const status = raw["http.response.status_code"];
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599)
    output["http.response.status_code"] = status;
  if (id(raw["sentry.trace.parent_span_id"], 16))
    output["sentry.trace.parent_span_id"] = raw["sentry.trace.parent_span_id"];
  return output;
}

export function filterLog(log: Log, config: Config, operations: Operations): Log | null {
  if (
    typeof log.message !== "string" ||
    !Object.hasOwn(messages, log.message) ||
    messages[log.message as keyof typeof messages] !== log.level
  )
    return null;
  const safe = attributes(log.attributes, config, operations);
  if (!safe.operation || !safe.outcome) return null;
  return {
    level: log.level,
    message: log.message,
    severityNumber: log.level === "error" ? 17 : 13,
    attributes: safe,
  };
}
export function filterMetric(
  metric: Metric,
  config: Config,
  operations: Operations,
): Metric | null {
  if (
    !Object.hasOwn(metricKinds, metric.name) ||
    metricKinds[metric.name as keyof typeof metricKinds] !== metric.type ||
    !nonnegative(metric.value) ||
    (metric.type === "counter" && (metric.value !== 1 || metric.unit !== undefined)) ||
    (metric.type === "distribution" && metric.unit !== "millisecond")
  )
    return null;
  const safe = attributes(metric.attributes, config, operations);
  // This Worker has only one top-level business operation; child phases must not double-count it.
  if (safe.operation !== "update.request" || !safe.outcome) return null;
  return {
    name: metric.name,
    type: metric.type,
    value: metric.value,
    ...(metric.unit ? { unit: metric.unit } : {}),
    attributes: safe,
  };
}
const untyped = (value: unknown) =>
  Object.fromEntries(
    Object.entries(record(value) ?? {}).flatMap(([key, value]) => {
      const entry = record(value);
      return entry &&
        ((entry.type === "string" && typeof entry.value === "string") ||
          (["integer", "double"].includes(String(entry.type)) &&
            typeof entry.value === "number" &&
            Number.isFinite(entry.value)))
        ? [[key, entry.value]]
        : [];
    }),
  );
const typed = (value: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(value).map(([key, value]) => [
      key,
      {
        type:
          typeof value === "number" ? (Number.isInteger(value) ? "integer" : "double") : "string",
        value,
      },
    ]),
  );

/** Synchronous reconstruction adds no asynchronous filtering queue to SDK flush. */
export function filterQualityItem(
  type: string,
  payload: unknown,
  config: Config,
  operations: Operations,
): [Record<string, unknown>, unknown] | undefined {
  const body = record(payload);
  if (!body) return;
  if (type === "client_report") {
    if (!nonnegative(body.timestamp) || !Array.isArray(body.discarded_events)) return;
    const discarded_events = body.discarded_events.flatMap((value: unknown) => {
      const event = record(value);
      return event &&
        typeof event.reason === "string" &&
        reasons.has(event.reason) &&
        typeof event.category === "string" &&
        categories.has(event.category) &&
        typeof event.quantity === "number" &&
        Number.isSafeInteger(event.quantity) &&
        event.quantity > 0
        ? [{ reason: event.reason, category: event.category, quantity: event.quantity }]
        : [];
    });
    if (discarded_events.length) return [{ type }, { timestamp: body.timestamp, discarded_events }];
    return;
  }
  if (!["log", "trace_metric"].includes(type) || body.version !== 2 || !Array.isArray(body.items))
    return;
  const items = body.items.flatMap<Record<string, unknown>>((value: unknown) => {
    const raw = record(value);
    if (!raw || !nonnegative(raw.timestamp) || (type === "trace_metric" && !id(raw.trace_id, 32)))
      return [];
    const correlation = {
      ...(id(raw.trace_id, 32) ? { trace_id: raw.trace_id } : {}),
      ...(type === "trace_metric" && id(raw.span_id, 16) ? { span_id: raw.span_id } : {}),
    };
    if (type === "log") {
      const clean = filterLog(
        { level: raw.level, message: raw.body, attributes: untyped(raw.attributes) } as Log,
        config,
        operations,
      );
      return clean
        ? [
            {
              timestamp: raw.timestamp,
              ...correlation,
              level: clean.level,
              body: clean.message,
              severity_number: clean.severityNumber,
              attributes: typed(clean.attributes ?? {}),
            },
          ]
        : [];
    }
    const clean = filterMetric(
      {
        name: raw.name,
        type: raw.type,
        unit: raw.unit,
        value: raw.value,
        attributes: untyped(raw.attributes),
      } as Metric,
      config,
      operations,
    );
    return clean
      ? [
          {
            timestamp: raw.timestamp,
            ...correlation,
            name: clean.name,
            type: clean.type,
            unit: clean.unit,
            value: clean.value,
            attributes: typed(clean.attributes ?? {}),
          },
        ]
      : [];
  });
  if (items.length)
    return [
      {
        type,
        content_type:
          type === "log"
            ? "application/vnd.sentry.items.log+json"
            : "application/vnd.sentry.items.trace-metric+json",
        item_count: items.length,
      },
      { version: 2, items },
    ];
}

export function degraded(operation: Operation, error?: unknown) {
  try {
    logger.warn("operation.degraded", {
      operation,
      outcome:
        error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)
          ? "cancelled"
          : "error",
    });
  } catch {
    /* telemetry cannot fail the request */
  }
}

export async function observeRequest(callback: () => Promise<Response>): Promise<Response> {
  const started = performance.now();
  let outcome = "success";
  let status: number | undefined;
  try {
    const response = await callback();
    status = response.status;
    if (status >= 500) outcome = "error";
    else if (status >= 400) outcome = "rejected";
    return response;
  } catch (error) {
    outcome =
      error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)
        ? "cancelled"
        : "error";
    try {
      logger.error("operation.failed", { operation: "update.request", outcome });
    } catch {
      /* preserve original error */
    }
    throw error;
  } finally {
    try {
      const duration = Math.max(0, performance.now() - started);
      const attributes = {
        operation: "update.request",
        outcome,
        duration_ms: duration,
        ...(status ? { "http.response.status_code": status } : {}),
      };
      metrics.count("app.operation.count", 1, { attributes });
      metrics.distribution("app.operation.duration", duration, { unit: "millisecond", attributes });
    } catch {
      /* no metrics failure may change business completion */
    }
  }
}
