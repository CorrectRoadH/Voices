// @concord-file
// @concord-implements docs/feature/updates/use-case/check-updates.md
import {
  withSentry,
  captureMessage,
  getIsolationScope,
  linkedErrorsIntegration,
  startSpan,
  type Span,
  type CloudflareClient,
  spanStreamingIntegration,
  SDK_VERSION,
  type CloudflareOptions,
  type ErrorEvent,
} from "@sentry/cloudflare";

import { filterLog, filterMetric, filterQualityItem, observeRequest } from "./quality.ts";
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

const filtered = "[Filtered]";
const sentryPublicKey = new URL(UPDATE_SENTRY_DSN).username;
const sensitiveHeader = /authorization|cookie|token|secret|key|password/i;

function sensitiveKey(key: string) {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return (
    /^(?:(?:auth|authorization|oauth|verification)[_-]?)?code$/i.test(words) ||
    /(?:^|[^a-z0-9])(?:token|secret|password|passwd|api[_-]?key|signature|sig|session)(?:$|[^a-z0-9])/i.test(
      words,
    )
  );
}

function filterText(value: string) {
  return value
    .replace(/\bBearer\s+[^\s"'<>[\](),;]+/gi, `Bearer ${filtered}`)
    .replace(/\b(?:sk|pk)-[\w-]+/g, filtered)
    .replace(/(?<![\w-])eyJ[\w-]+\.[\w-]+\.[\w-]+(?![\w-])/g, filtered)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#@"'<>]+@/gi, `$1${filtered}@`)
    .replace(/([?&])([^\s=&?#"'<>]+)=([^\s&#"'<>]*)/g, (pair, separator: string, key: string) => {
      let name = key;
      try {
        name = decodeURIComponent(key.replaceAll("+", " "));
      } catch {
        // Retain the literal key when percent encoding is malformed.
      }
      return sensitiveKey(name) ? `${separator}${key}=${filtered}` : pair;
    })
    .replaceAll(sentryPublicKey, filtered);
}

function filterValue(value: unknown): unknown {
  if (typeof value === "string") return filterText(value);
  if (Array.isArray(value)) return value.map(filterValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      filterText(key),
      sensitiveKey(key) ? filtered : filterValue(nested),
    ]),
  );
}

function filterRequest(request: ErrorEvent["request"]): ErrorEvent["request"] {
  if (!request) return undefined;
  const query = request.query_string;
  return {
    url: request.url && filterText(request.url),
    method: request.method,
    headers:
      request.headers &&
      Object.fromEntries(
        Object.entries(request.headers).map(([key, value]) => [
          key,
          sensitiveHeader.test(key) ? filtered : filterText(value),
        ]),
      ),
    query_string:
      typeof query === "string"
        ? filterText(`?${query}`).slice(1)
        : Array.isArray(query)
          ? query.map(([key, value]): [string, string] => [
              key,
              sensitiveKey(key) ? filtered : filterText(value),
            ])
          : (filterValue(query) as typeof query),
  };
}

const debugId = (value?: string) =>
  value && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
    ? value
    : undefined;

export function filterError(event: ErrorEvent, env: TelemetryEnv): ErrorEvent {
  return {
    ...(filterValue({
      ...event,
      request: undefined,
      user: undefined,
      sdkProcessingMetadata: undefined,
      exception: event.exception && {
        values: event.exception.values?.map((exception) => ({
          ...exception,
          stacktrace: exception.stacktrace && {
            ...exception.stacktrace,
            frames: exception.stacktrace.frames?.map((frame) => ({
              ...frame,
              vars: undefined,
              context_line: undefined,
              pre_context: undefined,
              post_context: undefined,
            })),
          },
        })),
      },
      debug_meta: event.debug_meta && {
        images: event.debug_meta.images?.filter(
          (image) => image.type === "sourcemap" && debugId(image.debug_id),
        ),
      },
      tags: { ...event.tags, component: "update" },
      transaction: "update.request",
    }) as ErrorEvent),
    type: undefined,
    platform: "javascript",
    level: "error",
    environment: identity(env.SENTRY_ENVIRONMENT) ?? "production",
    release: identity(env.SENTRY_RELEASE),
    request: filterRequest(event.request),
  };
}

function isClientFailure(event: ErrorEvent) {
  const status = Number(event.tags?.["http.status_code"]);
  return (
    (status >= 400 && status < 500) ||
    event.exception?.values?.some(
      (exception) => exception.type === "AbortError" && exception.mechanism?.handled === false,
    )
  );
}

/** The finite registry is shared by instrumentation and both privacy boundaries. */
const operations = {
  "update.request": "http.server",
  "update.cache.read": "cache.get",
  "update.upstream.fetch": "http.client",
  "update.response": "function",
  "update.analytics": "function",
} as const;
export type Operation = keyof typeof operations;
const operation = (value: unknown): Operation =>
  typeof value === "string" && Object.hasOwn(operations, value)
    ? (value as Operation)
    : "update.request";
const outcomes = ["success", "error", "cancelled", "hit", "miss", "skipped"];
const validId = (value: unknown, length: number): value is string =>
  typeof value === "string" &&
  value.length === length &&
  /^[a-f0-9]+$/.test(value) &&
  !/^0+$/.test(value);

function failed(span: Span, error: unknown) {
  const cancelled = error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
  span.setAttribute("outcome", cancelled ? "cancelled" : "error");
  span.setStatus({ code: 2, message: cancelled ? "cancelled" : "internal_error" });
}

/** SDK startSpan owns the active scope and ends once, including rejected promises. */
export function stage<T>(name: Operation, callback: (span: Span) => T): T {
  return startSpan({ name, op: operations[name], attributes: { operation: name } }, (span) => {
    span.setAttribute("outcome", "success");
    try {
      const result = callback(span);
      if (result instanceof Promise) {
        return result.catch((error: unknown) => {
          failed(span, error);
          throw error;
        }) as T;
      }
      return result;
    } catch (error) {
      failed(span, error);
      throw error;
    }
  });
}

type StreamedSpan = Parameters<NonNullable<CloudflareOptions["beforeSendSpan"]>>[0];
export function filterSpan(span: StreamedSpan, env: TelemetryEnv): StreamedSpan {
  const name = operation(span.name);
  const attributes: StreamedSpan["attributes"] = {
    component: "update",
    operation: name,
    "sentry.op": operations[name],
    "sentry.segment.name": "update.request",
    "sentry.environment": identity(env.SENTRY_ENVIRONMENT) ?? "production",
  };
  const outcome = span.attributes.outcome;
  if (typeof outcome === "string" && outcomes.includes(outcome)) attributes.outcome = outcome;
  for (const key of ["sentry.sample_rate", "http.response.status_code"] as const) {
    const value = span.attributes[key];
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      (key !== "sentry.sample_rate" || (value >= 0 && value <= 1))
    )
      attributes[key] = value;
  }
  if (
    typeof span.attributes["sentry.origin"] === "string" &&
    ["auto.http.cloudflare", "manual"].includes(span.attributes["sentry.origin"])
  )
    attributes["sentry.origin"] = span.attributes["sentry.origin"];
  const segment = span.attributes["sentry.segment.id"];
  if (validId(segment, 16)) attributes["sentry.segment.id"] = segment;
  if (identity(env.SENTRY_RELEASE)) attributes["sentry.release"] = identity(env.SENTRY_RELEASE);
  return {
    trace_id: span.trace_id,
    span_id: span.span_id,
    ...(validId(span.parent_span_id, 16) ? { parent_span_id: span.parent_span_id } : {}),
    start_timestamp: span.start_timestamp,
    end_timestamp: span.end_timestamp,
    status: span.status,
    is_segment: span.is_segment,
    name,
    attributes,
  };
}

type Envelope = Parameters<NonNullable<ReturnType<CloudflareClient["getTransport"]>>["send"]>[0];
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Called again at transport.send, after every beforeEnvelope listener. */
export function filterEnvelope(
  envelope: Envelope,
  env: TelemetryEnv,
  publicKey?: string,
): Envelope {
  const items: [Record<string, unknown>, unknown][] = [];
  for (const [header, payload] of envelope[1]) {
    try {
      const body = record(payload);
      if (!body) continue;
      const quality = filterQualityItem(
        header.type,
        body,
        {
          environment: identity(env.SENTRY_ENVIRONMENT) ?? "production",
          release: identity(env.SENTRY_RELEASE),
        },
        operations,
      );
      if (quality) {
        items.push(quality);
        continue;
      }
      if (header.type === "event" && body.type === undefined) {
        const event = { ...body, type: undefined } as ErrorEvent;
        if (!isClientFailure(event)) items.push([{ type: "event" }, filterError(event, env)]);
      } else if (header.type === "span" && body.version === 2 && Array.isArray(body.items)) {
        const spans = body.items.flatMap((value: unknown) => {
          const raw = record(value);
          if (
            !raw ||
            !validId(raw.trace_id, 32) ||
            !validId(raw.span_id, 16) ||
            typeof raw.start_timestamp !== "number" ||
            !Number.isFinite(raw.start_timestamp) ||
            typeof raw.end_timestamp !== "number" ||
            !Number.isFinite(raw.end_timestamp) ||
            raw.end_timestamp < raw.start_timestamp ||
            !["ok", "error"].includes(String(raw.status)) ||
            typeof raw.is_segment !== "boolean"
          )
            return [];
          const attributes = Object.fromEntries(
            Object.entries(record(raw.attributes) ?? {}).flatMap(([key, value]) => {
              const typed = record(value);
              return typed &&
                ["string", "integer", "double", "boolean"].includes(String(typed.type))
                ? [[key, typed.value]]
                : [];
            }),
          );
          const clean = filterSpan({ ...raw, attributes } as StreamedSpan, env);
          return [
            {
              ...clean,
              attributes: Object.fromEntries(
                Object.entries(clean.attributes).map(([key, value]) => [
                  key,
                  {
                    type:
                      typeof value === "number"
                        ? Number.isInteger(value)
                          ? "integer"
                          : "double"
                        : typeof value,
                    value,
                  },
                ]),
              ),
            },
          ];
        });
        if (spans.length)
          items.push([
            {
              type: "span",
              item_count: spans.length,
              content_type: "application/vnd.sentry.items.span.v2+json",
            },
            { version: 2, items: spans },
          ]);
      }
    } catch {
      // Malformed items fail closed independently of valid items in the same envelope.
    }
    // Worker has no CPU profiler, browser sessions or scheduler. Those and unknown items stay denied.
  }
  const rawTrace = record(envelope[0].trace);
  const spanBody = record(items.find(([header]) => header.type === "span")?.[1]);
  const first = Array.isArray(spanBody?.items) ? record(spanBody.items[0]) : undefined;
  const traceId = first?.trace_id ?? rawTrace?.trace_id;
  const rate = rawTrace?.sample_rate;
  const random = rawTrace?.sample_rand;
  const sampled = rawTrace?.sampled;
  const trace = validId(traceId, 32)
    ? {
        trace_id: traceId,
        public_key: publicKey,
        environment: identity(env.SENTRY_ENVIRONMENT) ?? "production",
        release: identity(env.SENTRY_RELEASE),
        transaction: "update.request",
        ...(typeof rate === "string" && /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(rate)
          ? { sample_rate: rate }
          : {}),
        ...(typeof random === "string" && /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(random)
          ? { sample_rand: random }
          : {}),
        ...(sampled === "true" || sampled === "false" ? { sampled } : {}),
      }
    : undefined;
  return [
    {
      ...(validId(envelope[0].event_id, 32) ? { event_id: envelope[0].event_id } : {}),
      ...(typeof envelope[0].sent_at === "string" &&
      Number.isFinite(Date.parse(envelope[0].sent_at))
        ? { sent_at: new Date(envelope[0].sent_at).toISOString() }
        : {}),
      sdk: { name: "sentry.javascript.cloudflare", version: SDK_VERSION },
      ...(trace ? { trace } : {}),
    },
    items,
  ] as Envelope;
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
      linkedErrorsIntegration(),
      {
        name: "UpdateEnvelopePrivacy",
        setup(client) {
          const transport = client.getTransport();
          if (transport) {
            const send = transport.send.bind(transport);
            transport.send = (envelope) => {
              const clean = filterEnvelope(envelope, env, client.getDsn()?.publicKey);
              return clean[1].length ? send(clean) : Promise.resolve({});
            };
          }
          client.on("beforeEnvelope", (envelope) => {
            const clean = filterEnvelope(envelope, env, client.getDsn()?.publicKey);
            envelope[0] = clean[0];
            envelope[1] = clean[1];
          });
        },
      },
    ],
    beforeSendLog: (log) =>
      filterLog(
        log,
        {
          environment: identity(env.SENTRY_ENVIRONMENT) ?? "production",
          release: identity(env.SENTRY_RELEASE),
        },
        operations,
      ),
    beforeSendMetric: (metric) =>
      filterMetric(
        metric,
        {
          environment: identity(env.SENTRY_ENVIRONMENT) ?? "production",
          release: identity(env.SENTRY_RELEASE),
        },
        operations,
      ),
    // Cloudflare 11.12 records outcomes but exposes no public automatic report drain.
    sendClientReports: true,
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
    beforeSend: (event) => (isClientFailure(event) ? null : filterError(event, env)),
    beforeSendSpan: (span) => filterSpan(span, env),
  };
}

/** The official wrapper owns invocation isolation and waitUntil flushing; the SDK caches one client per isolate. */
export function monitor<T extends TelemetryEnv>(handler: {
  fetch(request: Request, env: T, ctx: ExecutionContext): Promise<Response>;
}) {
  return {
    fetch(request: Request, env: T, ctx: ExecutionContext) {
      if (!telemetryDsn(env)) return handler.fetch(request, env, ctx);
      // Only the SDK sees rebuilt trace headers. Business receives its original Request,
      // including body, AbortSignal, cf metadata and all original headers.
      const headers = new Headers(request.headers);
      const incoming = headers.get("sentry-trace");
      const parts = incoming?.match(/^([a-f0-9]{32})-([a-f0-9]{16})(?:-([01]))?$/);
      headers.delete("baggage");
      if (!parts || !validId(parts[1], 32) || !validId(parts[2], 16))
        headers.delete("sentry-trace");
      const sdkRequest = new Proxy(request, {
        get(target, key) {
          if (key === "headers") return headers;
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const monitored = withSentry((env: T) => telemetryOptions(env), {
        async fetch(_sdkRequest: Request, env: T, ctx: ExecutionContext) {
          const url = new URL(request.url);
          url.hash = "";
          getIsolationScope().addEventProcessor((event) => {
            if (request.signal.aborted) return null;
            return {
              ...event,
              request: { ...event.request, url: url.href, method: request.method },
              tags: {
                operation: "update.request",
                ...event.tags,
                route: url.pathname === "/" ? "/" : "<unmatched>",
                "http.method": request.method,
                "http.status_code":
                  event.tags?.["http.status_code"] ?? event.contexts?.response?.status_code ?? 500,
              },
            };
          });
          const response = await (["OPTIONS", "HEAD"].includes(request.method)
            ? handler.fetch(request, env, ctx)
            : observeRequest(() => handler.fetch(request, env, ctx)));
          if (response.status >= 500)
            captureMessage(`HTTP ${response.status}`, {
              level: "error",
              tags: { "http.status_code": response.status },
            });
          return response;
        },
      });
      return monitored.fetch(sdkRequest, env, ctx);
    },
  };
}
