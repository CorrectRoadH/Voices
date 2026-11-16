// @concord-file
// @concord-implements docs/feature/updates/use-case/check-updates.md
import {
  withSentry,
  spanStreamingIntegration,
  SDK_VERSION,
  type CloudflareOptions,
  type ErrorEvent,
} from "@sentry/cloudflare";

import { UPDATE_SENTRY_DSN } from "./sentry-config.ts";

export interface TelemetryEnv {
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;
}

const identity = (value?: string) =>
  value && /^[a-zA-Z0-9][a-zA-Z0-9._@+-]{0,127}$/.test(value) ? value : undefined;

export function telemetryDsn(env: TelemetryEnv): string | undefined {
  return import.meta.env.PROD &&
    !["development", "test", "preview"].includes(env.SENTRY_ENVIRONMENT ?? "")
    ? UPDATE_SENTRY_DSN
    : undefined;
}

function origin(value?: string): string | undefined {
  try {
    return value ? new URL(value).origin : undefined;
  } catch {
    return undefined;
  }
}

function codeFile(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol)
      ? url.origin + url.pathname
      : value.split(/[?#]/, 1)[0];
  } catch {
    return value.split(/[?#]/, 1)[0];
  }
}
const debugId = (value?: string) =>
  value && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
    ? value
    : undefined;

export function filterError(event: ErrorEvent, env: TelemetryEnv): ErrorEvent {
  const trace = event.contexts?.trace;
  return {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: "javascript",
    level: "error",
    environment: identity(env.SENTRY_ENVIRONMENT) ?? "production",
    release: identity(env.SENTRY_RELEASE),
    tags: { component: "update" },
    transaction: "update.request",
    request: event.request?.url ? { url: origin(event.request.url) } : undefined,
    contexts:
      trace &&
      /^[a-f0-9]{32}$/.test(trace.trace_id ?? "") &&
      /^[a-f0-9]{16}$/.test(trace.span_id ?? "")
        ? { trace: { trace_id: trace.trace_id, span_id: trace.span_id, op: "http.server" } }
        : undefined,
    debug_meta: {
      images: event.debug_meta?.images?.flatMap((image) =>
        image.type === "sourcemap" && debugId(image.debug_id)
          ? [
              {
                type: "sourcemap",
                debug_id: image.debug_id,
                code_file: codeFile(image.code_file) ?? "index.js",
              },
            ]
          : [],
      ),
    },
    exception: {
      values: event.exception?.values?.map((exception) => ({
        type: [
          "Error",
          "TypeError",
          "RangeError",
          "SyntaxError",
          "AbortError",
          "TimeoutError",
        ].includes(exception.type ?? "")
          ? exception.type
          : "Error",
        value: "Update service error",
        mechanism: exception.mechanism
          ? {
              type: [
                "generic",
                "auto.http.cloudflare",
                "auto.faas.cloudflare",
                "auto.faas.cloudflare.durable_object",
              ].includes(exception.mechanism.type)
                ? exception.mechanism.type
                : "generic",
              ...(typeof exception.mechanism.handled === "boolean"
                ? { handled: exception.mechanism.handled }
                : {}),
              ...(typeof exception.mechanism.is_exception_group === "boolean"
                ? { is_exception_group: exception.mechanism.is_exception_group }
                : {}),
            }
          : undefined,
        stacktrace: exception.stacktrace
          ? {
              frames: exception.stacktrace.frames?.map((frame) => ({
                function: frame.function,
                filename: codeFile(frame.filename),
                debug_id: debugId(frame.debug_id),
                module: frame.module,
                lineno: frame.lineno,
                colno: frame.colno,
              })),
            }
          : undefined,
      })),
    },
  };
}

type StreamedSpan = Parameters<NonNullable<CloudflareOptions["beforeSendSpan"]>>[0];
export function filterSpan(span: StreamedSpan, env: TelemetryEnv): StreamedSpan {
  const attributes: StreamedSpan["attributes"] = {
    component: "update",
    "sentry.op": "http.server",
  };
  for (const key of ["sentry.sample_rate", "http.response.status_code"] as const) {
    const value = span.attributes[key];
    if (typeof value === "number" && Number.isFinite(value)) attributes[key] = value;
  }
  if (["auto.http.cloudflare", "manual"].includes(String(span.attributes["sentry.origin"])))
    attributes["sentry.origin"] = span.attributes["sentry.origin"];
  const segment = span.attributes["sentry.segment.id"];
  if (typeof segment === "string" && /^[a-f0-9]{16}$/.test(segment))
    attributes["sentry.segment.id"] = segment;
  attributes["sentry.segment.name"] = "update.request";
  if (identity(env.SENTRY_RELEASE)) attributes["sentry.release"] = identity(env.SENTRY_RELEASE);
  attributes["sentry.environment"] = identity(env.SENTRY_ENVIRONMENT) ?? "production";
  return {
    trace_id: span.trace_id,
    span_id: span.span_id,
    parent_span_id: span.parent_span_id,
    start_timestamp: span.start_timestamp,
    end_timestamp: span.end_timestamp,
    status: span.status,
    is_segment: span.is_segment,
    name: "update.request",
    attributes,
  };
}

export function telemetryOptions(env: TelemetryEnv): CloudflareOptions {
  return {
    dsn: telemetryDsn(env),
    environment: identity(env.SENTRY_ENVIRONMENT) ?? "production",
    release: identity(env.SENTRY_RELEASE),
    traceLifecycle: "stream",
    tracesSampleRate: 0.01,
    tracePropagationTargets: [],
    enableOpenTelemetrySetup: false,
    defaultIntegrations: false,
    integrations: [
      spanStreamingIntegration({ flushOnSegmentEnd: false }),
      {
        name: "UpdateEnvelopePrivacy",
        setup(client) {
          client.on("beforeEnvelope", (envelope) => {
            const header = envelope[0];
            // DSC is assembled after beforeSend, so item hooks alone cannot protect it.
            const rawTrace = header.trace;
            const trace =
              rawTrace &&
              typeof rawTrace === "object" &&
              "trace_id" in rawTrace &&
              typeof rawTrace.trace_id === "string" &&
              /^[a-f0-9]{32}$/.test(rawTrace.trace_id)
                ? {
                    trace_id: rawTrace.trace_id,
                    public_key: new URL(telemetryDsn(env)!).username,
                    environment: identity(env.SENTRY_ENVIRONMENT) ?? "production",
                    release: identity(env.SENTRY_RELEASE),
                    transaction: "update.request",
                  }
                : undefined;
            envelope[0] = {
              ...(typeof header.event_id === "string" && /^[a-f0-9]{32}$/.test(header.event_id)
                ? { event_id: header.event_id }
                : {}),
              ...(typeof header.sent_at === "string" && Number.isFinite(Date.parse(header.sent_at))
                ? { sent_at: new Date(header.sent_at).toISOString() }
                : {}),
              sdk: { name: "sentry.javascript.cloudflare", version: SDK_VERSION },
              ...(trace ? { trace } : {}),
            };
            // No attachments, sessions, replay, logs, metrics or other payload classes.
            for (let index = envelope[1].length - 1; index >= 0; index--) {
              const item = envelope[1][index];
              if (item[0].type !== "event" && item[0].type !== "span") envelope[1].splice(index, 1);
              else for (const key of Object.keys(item[0])) if (key !== "type") delete item[0][key];
            }
          });
        },
      },
    ],
    beforeSendLog: () => null,
    beforeSendMetric: () => null,
    sendClientReports: false,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      graphQL: { document: false, variables: false },
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    beforeSend: (event) => filterError(event, env),
    beforeSendSpan: (span) => filterSpan(span, env),
  };
}

/** The official wrapper owns invocation isolation and waitUntil flushing; the SDK caches one client per isolate. */
export function monitor<T extends TelemetryEnv>(handler: {
  fetch(request: Request, env: T, ctx: ExecutionContext): Promise<Response>;
}) {
  const monitored = withSentry((env: T) => telemetryOptions(env), { ...handler });
  return {
    fetch(request: Request, env: T, ctx: ExecutionContext) {
      return telemetryDsn(env)
        ? monitored.fetch(request, env, ctx)
        : handler.fetch(request, env, ctx);
    },
  };
}
