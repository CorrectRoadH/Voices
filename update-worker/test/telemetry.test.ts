import { describe, expect, it } from "vite-plus/test";
import { UPDATE_SENTRY_DSN } from "../src/sentry-config.ts";
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
              code_file: "https://code.test/index.js?token=PRIVATE_SENTINEL",
            },
            { type: "sourcemap", debug_id: "PRIVATE_SENTINEL", code_file: "secret" },
          ],
        },
        exception: {
          values: [
            {
              type: "Error",
              value: "load manifest: invalid releases",
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
      { type: "sourcemap", debug_id: id, code_file: "https://code.test/index.js?token=[Filtered]" },
    ]);
    expect(event.exception?.values?.[0].stacktrace?.frames?.[0].debug_id).toBe(id);
  });

  // @concord-implements docs/feature/updates/use-case/check-updates.md
  it("preserves business details and filters credentials throughout an error event", () => {
    const jwt = [JSON.stringify({ alg: "HS256" }), JSON.stringify({ sub: "test" }), "signature"]
      .map((segment) => Buffer.from(segment).toString("base64url"))
      .join(".");
    const business = "load release notes: package.json; SELECT title FROM updates WHERE id = 42";
    const event = filterError(
      {
        type: undefined,
        message: business,
        request: {
          method: "GET",
          url: "https://update.test/releases?version=1.2.3&%74oken=query-credential&code=oauth-code)credential-suffix",
          query_string: [
            ["session", "session-credential"],
            ["version", "1.2.3"],
          ],
          headers: {
            Authorization: "Bearer authorization-credential",
            Cookie: "login=cookie-credential",
            "Set-Cookie": "login=set-cookie-credential",
            "X-Api-Key": "api-key-credential",
            "X-Update-Token": "custom-header-credential",
            "X-Version": "1.2.3",
          },
        },
        exception: {
          values: [
            {
              type: "ReleaseError",
              value: business,
              stacktrace: {
                frames: [
                  {
                    function: "loadManifest",
                    filename: "src/manifest.ts",
                    abs_path: "https://build.test/manifest.ts",
                    lineno: 37,
                    colno: 2,
                    in_app: true,
                  },
                ],
              },
            },
            {
              type: "GitHubError",
              value: `Bearer example-credential; https://name:userinfo-credential@updates.test/file?sig=signed-value&version=next ${jwt}. sk-test-key pk-test-key ${new URL(UPDATE_SENTRY_DSN).username}`,
            },
          ],
        },
        extra: {
          file: "changes.md",
          error_code: "invalid_release",
          nested: [
            { accessToken: "nested-credential", signature: "signed-value", description: business },
          ],
        },
        breadcrumbs: [{ message: business, data: { password: "breadcrumb-credential", page: 2 } }],
      },
      {},
    );
    const serialized = JSON.stringify(event);

    expect(event.message).toBe(business);
    expect(event.exception?.values?.[0]).toMatchObject({
      type: "ReleaseError",
      value: business,
      stacktrace: {
        frames: [
          {
            function: "loadManifest",
            filename: "src/manifest.ts",
            abs_path: "https://build.test/manifest.ts",
            lineno: 37,
            colno: 2,
            in_app: true,
          },
        ],
      },
    });
    expect(event.exception?.values?.[1].value).toBe(
      "Bearer [Filtered]; https://[Filtered]@updates.test/file?sig=[Filtered]&version=next [Filtered]. [Filtered] [Filtered] [Filtered]",
    );
    expect(event.request).toEqual({
      method: "GET",
      url: "https://update.test/releases?version=1.2.3&%74oken=[Filtered]&code=[Filtered]",
      query_string: [
        ["session", "[Filtered]"],
        ["version", "1.2.3"],
      ],
      headers: {
        Authorization: "[Filtered]",
        Cookie: "[Filtered]",
        "Set-Cookie": "[Filtered]",
        "X-Api-Key": "[Filtered]",
        "X-Update-Token": "[Filtered]",
        "X-Version": "1.2.3",
      },
    });
    expect(event.extra).toEqual({
      file: "changes.md",
      error_code: "invalid_release",
      nested: [{ accessToken: "[Filtered]", signature: "[Filtered]", description: business }],
    });
    expect(event.breadcrumbs?.[0]).toEqual({
      message: business,
      data: { password: "[Filtered]", page: 2 },
    });
    expect(serialized).not.toContain("credential");
    expect(JSON.stringify(filterError(event, {}))).toBe(serialized);
  });
});
