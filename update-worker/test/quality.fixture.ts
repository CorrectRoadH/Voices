// Test-only SDK boundary. No public endpoint or deployment entry references this file.
import {
  withSentry,
  getClient,
  getCurrentScope,
  getIsolationScope,
  getGlobalScope,
  logger,
  metrics,
  withScope,
} from "@sentry/cloudflare";
import { telemetryOptions, type TelemetryEnv } from "../src/telemetry.ts";
import { observeRequest } from "../src/quality.ts";
const sentinel = "PRIVATE_SENTINEL_quality_913";
export default withSentry(
  (env: TelemetryEnv) => {
    const options = telemetryOptions(env);
    return {
      ...options,
      tracesSampleRate: 0,
      integrations: [
        ...(Array.isArray(options.integrations) ? options.integrations : []),
        {
          name: "LateQualitySentinel",
          setup(client) {
            client.on("beforeEnvelope", (envelope) => {
              envelope[0].private = { nested: sentinel };
              for (const [header, payload] of envelope[1]) {
                if (
                  (header.type === "log" || header.type === "trace_metric") &&
                  payload &&
                  typeof payload === "object" &&
                  "items" in payload &&
                  Array.isArray(payload.items)
                ) {
                  header.item_count = 999;
                  Object.assign(payload, { private: sentinel });
                  for (const item of payload.items) {
                    Object.assign(item, { private: { nested: sentinel } });
                    Object.assign(item.attributes ?? {}, {
                      private: { type: "string", value: sentinel },
                    });
                  }
                }
              }
            });
          },
        },
      ],
    };
  },
  {
    async fetch(request: Request) {
      const mode = new URL(request.url).searchParams.get("mode");
      for (const scope of [getGlobalScope(), getIsolationScope(), getCurrentScope()]) {
        scope.setUser({ id: sentinel, email: `${sentinel}@test.invalid`, ip_address: "192.0.2.1" });
        scope.setAttribute("scope.private", { nested: sentinel });
        scope.setAttribute("operation", sentinel);
      }
      if (mode === "scope") {
        // Bypass client.sendEnvelope and all listeners: final transport must still deny it.
        await getClient()
          ?.getTransport()
          ?.send([
            { private: sentinel, sent_at: "2026-11-16T10:00:01.000Z" },
            [
              [
                { type: "session" },
                {
                  sid: "99999999999999999999999999999999",
                  init: true,
                  started: "2026-11-16T10:00:00.000Z",
                  timestamp: "2026-11-16T10:00:01.000Z",
                  status: "ok",
                  errors: 0,
                  attrs: { release: "update@quality-test", ip_address: sentinel },
                },
              ],
            ],
          ]);
        withScope((scope) => {
          scope.setAttribute("call.scope", sentinel);
          logger.warn("operation.degraded", {
            operation: "update.upstream.fetch",
            outcome: "error",
            private: sentinel,
          });
          logger.info(sentinel, { private: sentinel });
          metrics.count("app.operation.count", 1, {
            attributes: { operation: "update.request", outcome: "success", private: sentinel },
          });
          metrics.distribution("app.operation.duration", 12.5, {
            unit: "millisecond",
            attributes: { operation: "update.request", outcome: "success", private: sentinel },
          });
          metrics.count(sentinel, 1, { attributes: { private: sentinel } });
        });
        return new Response("ok");
      }
      if (mode === "reports") {
        getClient()?.recordDroppedEvent("before_send", "log_item");
        metrics.count("app.operation.count", 1, {
          attributes: { operation: "update.request", outcome: "success" },
        });
        metrics.distribution("app.operation.duration", 1, {
          unit: "millisecond",
          attributes: { operation: "update.request", outcome: "success" },
        });
        return new Response("recorded, no public automatic drain");
      }
      try {
        return await observeRequest(async () => {
          // Actual fetch boundary injects failure/cancellation; telemetry wrapper is real.
          const response = await fetch("https://external.test/");
          if (mode === "throw" || mode === "cancel") {
            await response.text();
            throw mode === "cancel"
              ? new DOMException(sentinel, "AbortError")
              : new Error(sentinel);
          }
          return new Response("ok", { status: mode === "reject" ? 400 : 200 });
        });
      } catch {
        return new Response("failed", { status: 500 });
      }
    },
  },
);
