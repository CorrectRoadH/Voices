import { describe, expect, it } from "vite-plus/test";
import { telemetryDsn, telemetryOptions, filterError } from "../src/telemetry.ts";

describe("update monitoring", () => {
  // @concord-implements docs/feature/updates/use-case/check-updates.md
  it("keeps development and test builds disabled", () => {
    for (const environment of [undefined, "", "development", "test", "preview", "production\n"])
      expect(telemetryDsn({ SENTRY_ENVIRONMENT: environment })).toBeUndefined();
    const env = { SENTRY_ENVIRONMENT: "production" };
    expect(telemetryDsn(env)).toBeUndefined();
    expect(telemetryOptions(env).tracesSampleRate).toBe(0.01);
    expect(telemetryOptions(env).tracePropagationTargets).toEqual([]);
  });
  // @concord-implements docs/feature/updates/use-case/check-updates.md
  it("retains validated source-map metadata and discards frame locals", () => {
    const id = "12345678-1234-1234-1234-123456789012";
    const event = filterError(
      {
        type: undefined,
        debug_meta: {
          images: [
            {
              type: "sourcemap",
              debug_id: id,
              code_file: "https://code.test/index.js?PRIVATE_SENTINEL=secret",
            },
            { type: "sourcemap", debug_id: "PRIVATE_SENTINEL", code_file: "secret" },
          ],
        },
        exception: {
          values: [
            {
              type: "Error",
              value: "PRIVATE_SENTINEL",
              stacktrace: {
                frames: [
                  {
                    filename: "index.js",
                    debug_id: id,
                    vars: { nested: { value: "PRIVATE_SENTINEL" } },
                  },
                ],
              },
            },
          ],
        },
      },
      {},
    );
    expect(JSON.stringify(event)).not.toContain("PRIVATE_SENTINEL");
    expect(event.debug_meta?.images).toEqual([
      { type: "sourcemap", debug_id: id, code_file: "https://code.test/index.js" },
    ]);
    expect(event.exception?.values?.[0].stacktrace?.frames?.[0].debug_id).toBe(id);
  });
});
