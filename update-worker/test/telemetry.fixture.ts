// Test-only entry: never included in the deployed Worker.
import { withSentry, startSpan, withScope, captureException } from "@sentry/cloudflare";
import { monitor, telemetryOptions, type TelemetryEnv } from "../src/telemetry.ts";
const sentinel = "PRIVATE_SENTINEL_nested_913";
const injectedEnvelope = withSentry(
  (env: TelemetryEnv) => {
    const options = telemetryOptions(env);
    return {
      ...options,
      tracesSampleRate: 1,
      integrations: [
        ...(Array.isArray(options.integrations) ? options.integrations : []),
        {
          name: "InjectSensitiveEnvelope",
          setup(client) {
            client.on("beforeEnvelope", (envelope) => {
              envelope[0].private = { nested: sentinel };
              const trace = envelope[0].trace;
              envelope[0].trace = {
                ...(trace && typeof trace === "object" ? trace : {}),
                transaction: sentinel,
                nested: { secret: sentinel },
              };
              for (const [header, payload] of envelope[1]) {
                Object.assign(payload, {
                  extra: { ...(payload as { extra?: object }).extra, secret: sentinel },
                });
                header.private = { nested: sentinel };
                if (header.type === "span") {
                  header.item_count = 999;
                  if (
                    payload &&
                    typeof payload === "object" &&
                    "items" in payload &&
                    Array.isArray(payload.items)
                  ) {
                    for (const span of payload.items) {
                      if (
                        span &&
                        typeof span === "object" &&
                        "attributes" in span &&
                        span.attributes &&
                        typeof span.attributes === "object"
                      )
                        Object.assign(span.attributes, {
                          private: { type: "string", value: sentinel },
                          "db.query.text": { type: "string", value: sentinel },
                        });
                    }
                  }
                }
              }
              Array.prototype.push.call(envelope[1], [
                { type: "event" },
                {
                  exception: { values: sentinel },
                  private: sentinel,
                },
              ]);
              Array.prototype.push.call(envelope[1], [
                { type: "span" },
                {
                  version: 2,
                  items: [{ trace_id: "0".repeat(32), span_id: "0".repeat(16), name: sentinel }],
                },
              ]);
              for (const type of [
                "profile",
                "profile_chunk",
                "session",
                "sessions",
                "replay_event",
                "replay_recording",
                "log",
                "metric",
                "check_in",
                "attachment",
                "unknown",
              ]) {
                Array.prototype.push.call(envelope[1], [{ type }, { nested: sentinel }]);
              }
            });
          },
        },
      ],
    };
  },
  {
    async fetch(_request: Request, _env: TelemetryEnv, _ctx: ExecutionContext) {
      await startSpan(
        {
          name: sentinel,
          op: "http.server",
          attributes: {
            "url.full": `https://test.invalid/${sentinel}?secret=${sentinel}`,
            "sentry.segment.name": sentinel,
          },
        },
        async () => {
          await startSpan(
            {
              name: sentinel,
              op: "db.query",
              attributes: {
                "db.query.text": sentinel,
                "gen_ai.prompt": sentinel,
                custom: JSON.stringify({ nested: { secret: sentinel } }),
              },
            },
            async () => {
              withScope((scope) => {
                scope.setUser({
                  id: sentinel,
                  email: `${sentinel}@test.invalid`,
                  ip_address: "192.0.2.1",
                });
                scope.setContext("business", { nested: { secret: sentinel } });
                scope.setExtra("nested", { secret: sentinel });
                scope.addBreadcrumb({
                  message: "Loading release notes",
                  data: { nested: { secret: sentinel } },
                });
                captureException(
                  new TypeError("Cannot decode release notes", {
                    cause: new SyntaxError(`Invalid document Bearer ${sentinel}`),
                  }),
                  {
                    mechanism: {
                      type: "auto.http.cloudflare",
                      handled: false,
                      is_exception_group: true,
                      data: { secret: sentinel },
                    },
                    captureContext: {
                      tags: { operation: "update.response" },
                      extra: { nested: { secret: sentinel } },
                    },
                  },
                );
              });
            },
          );
        },
      );
      return new Response("ok");
    },
  },
);

const failedRequests = monitor({
  async fetch(request: Request) {
    switch (request.headers.get("X-Fixture")) {
      case "abort":
        throw new DOMException("Client disconnected", "AbortError");
      case "throw":
        throw new TypeError("Failed to build release manifest");
      case "client-error":
        return new Response(null, { status: 405 });
      default:
        return new Response(null, { status: 503 });
    }
  },
});

export default {
  fetch(request: Request, env: TelemetryEnv, ctx: ExecutionContext) {
    return request.headers.has("X-Fixture")
      ? failedRequests.fetch(request, env, ctx)
      : injectedEnvelope.fetch(request, env, ctx);
  },
};
