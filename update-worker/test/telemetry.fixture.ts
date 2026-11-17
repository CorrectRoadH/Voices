// Test-only entry: never included in the deployed Worker.
import { withSentry, startSpan, withScope, captureException } from "@sentry/cloudflare";
import { telemetryOptions, type TelemetryEnv } from "../src/telemetry.ts";
const sentinel = "PRIVATE_SENTINEL_nested_913";
export default withSentry(
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
                Object.assign(payload, { private: { nested: sentinel } });
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
    async fetch() {
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
                  message: sentinel,
                  data: { nested: { secret: sentinel } },
                });
                captureException(new Error(sentinel), {
                  mechanism: {
                    type: "auto.http.cloudflare",
                    handled: false,
                    is_exception_group: true,
                    data: { private: sentinel },
                  },
                  captureContext: {
                    tags: { private: sentinel },
                    extra: { nested: { secret: sentinel } },
                  },
                });
              });
            },
          );
        },
      );
      return new Response("ok");
    },
  },
);
