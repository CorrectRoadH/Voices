import assert from "node:assert/strict";
import test from "node:test";
import { build } from "vite-plus";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

await build({ configFile: "test/telemetry.vite.config.ts" });

const release = {
  tag_name: "v0.0.1",
  draft: false,
  prerelease: false,
  html_url: "https://github.com/CorrectRoadH/Voices/releases/tag/v0.0.1",
  published_at: "2026-10-18T12:07:16Z",
  body: "First release",
};

function runtime(
  outboundService,
  bindings = {},
  scriptPath = ".cloudflare/output/v0/workers/default/bundle/index.js",
) {
  return new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath,
      compatibilityDate: "2026-10-01",
      compatibilityFlags: ["nodejs_compat"],
      bindings: { GITHUB_REPO: "CorrectRoadH/Voices", SENTRY_ENVIRONMENT: "test", ...bindings },
      outboundService,
    }),
  );
}

// @concord-implements docs/feature/updates/use-case/check-updates.md
void test("built Worker fetches a release in workerd without forwarding client parameters", async () => {
  let requests = 0;
  const mf = runtime(async (request) => {
    requests++;
    assert.equal(
      request.url,
      "https://api.github.com/repos/CorrectRoadH/Voices/releases?per_page=100&page=1",
    );
    return Response.json([release]);
  });
  try {
    const response = await mf.dispatchFetch(
      "https://worker.test/?instanceId=private-client-id&version=dev",
    );
    assert.equal((await response.json()).latestVersion, "0.0.1");
    assert.equal(requests, 1);
  } finally {
    await mf.dispose();
  }
});

// @concord-implements docs/feature/updates/use-case/check-updates.md
void test("built Worker refuses upstream redirects in workerd", async () => {
  let requests = 0;
  const mf = runtime(async () => {
    requests++;
    return new Response(null, { status: 302, headers: { Location: "https://untrusted.test/" } });
  });
  try {
    const response = await mf.dispatchFetch("https://worker.test/");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).latestVersion, null);
    assert.equal(requests, 1);
  } finally {
    await mf.dispose();
  }
});

const telemetry = {
  SENTRY_ENVIRONMENT: "",
  SENTRY_RELEASE: "update@local-test",
};
const sentinel = "PRIVATE_SENTINEL_voices_913";

// @concord-implements docs/feature/updates/use-case/check-updates.md
void test("real SDK sends sanitized errors and sampled spans through workerd waitUntil", async () => {
  const envelopes = [];
  let delivered;
  const delivery = new Promise((resolve) => {
    delivered = resolve;
  });
  const mf = runtime(async (request) => {
    if (new URL(request.url).hostname !== "api.github.com") {
      const text = await request.text();
      envelopes.push(text);
      if (
        envelopes.some((value) => value.includes('"exception"')) &&
        envelopes.some((value) => value.includes('"type":"span"'))
      )
        delivered();
      return new Response("{}", { headers: { "Content-Type": "application/json" } });
    }
    assert.equal(request.headers.get("sentry-trace"), null);
    assert.equal(request.headers.get("baggage"), null);
    throw new Error(sentinel);
  }, telemetry);
  let timeout;
  try {
    const response = await mf.dispatchFetch(
      `https://voices.niceeval.com/?instanceId=${sentinel}#${sentinel}`,
      {
        headers: {
          Authorization: `Bearer ${sentinel}`,
          Cookie: `session=${sentinel}`,
          "sentry-trace": "12345678901234567890123456789012-1234567890123456-1",
        },
      },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).latestVersion, null);
    await Promise.race([
      delivery,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("SDK envelopes not delivered")), 6000);
      }),
    ]);
    const text = envelopes.join("\n");
    assert.ok(!text.includes(sentinel), text);
    assert.ok(
      text.includes('"component":"update"') || text.includes('"component":{"value":"update"'),
    );
    assert.ok(text.includes("update@local-test"));
    assert.ok(text.includes("12345678901234567890123456789012"));
    const event = envelopes.flatMap((envelope) => {
      const lines = envelope.trim().split("\n");
      const result = [];
      for (let i = 1; i < lines.length; i += 2)
        if (JSON.parse(lines[i]).type === "event") result.push(JSON.parse(lines[i + 1]));
      return result;
    })[0];
    assert.equal(event.environment, "production");
    assert.ok(event.exception.values.every((value) => value.mechanism.handled === true));
    assert.ok(
      event.debug_meta.images.some(
        (image) => image.type === "sourcemap" && /^[a-f0-9-]{36}$/.test(image.debug_id),
      ),
    );
  } finally {
    clearTimeout(timeout);
    await mf.dispose();
  }
});

// @concord-implements docs/feature/updates/use-case/check-updates.md
void test("test and development disable telemetry and ingestion failure preserves updates", async () => {
  for (const environment of ["development", "test", "production"]) {
    let sent = 0;
    let attempted;
    const attempt = new Promise((resolve) => {
      attempted = resolve;
    });
    let timeout;
    const mf = runtime(
      async (request) => {
        if (new URL(request.url).hostname !== "api.github.com") {
          sent++;
          attempted();
          throw new Error("ingestion unavailable");
        }
        assert.equal(request.headers.get("sentry-trace"), null);
        assert.equal(request.headers.get("baggage"), null);
        throw new Error(sentinel);
      },
      { SENTRY_ENVIRONMENT: environment ?? "" },
    );
    try {
      const response = await mf.dispatchFetch("https://voices.niceeval.com/");
      assert.equal(response.status, 200);
      assert.equal((await response.json()).latestVersion, null);
      if (environment === "production")
        await Promise.race([
          attempt,
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error("ingestion was not attempted")), 6000);
          }),
        ]);
    } finally {
      clearTimeout(timeout);
      await mf.dispose();
    }
    if (environment !== "production") assert.equal(sent, 0);
    else assert.ok(sent > 0);
  }
});

// @concord-implements docs/feature/updates/use-case/check-updates.md
void test("real SDK removes sensitive root, child and injected DSC fields from entire envelopes", async () => {
  const envelopes = [];
  let delivered;
  const delivery = new Promise((resolve) => {
    delivered = resolve;
  });
  const mf = runtime(
    async (request) => {
      envelopes.push(await request.text());
      if (
        envelopes.some((text) => text.includes('"type":"event"')) &&
        envelopes.some((text) => text.includes('"type":"span"'))
      )
        delivered();
      return Response.json({});
    },
    telemetry,
    ".cloudflare/test-telemetry/index.js",
  );
  let timeout;
  try {
    const response = await mf.dispatchFetch(
      "https://voices.niceeval.com/PRIVATE_SENTINEL_nested_913?private=PRIVATE_SENTINEL_nested_913",
    );
    await response.text();
    await Promise.race([
      delivery,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("fixture envelopes not delivered")), 6000);
      }),
    ]);
    const text = envelopes.join("\n");
    assert.ok(!text.includes("PRIVATE_SENTINEL_nested_913"), text);
    const items = envelopes.flatMap((envelope) => {
      const lines = envelope.trim().split("\n");
      const header = JSON.parse(lines.shift());
      assert.equal(header.trace?.transaction, "update.request");
      assert.equal(header.private, undefined);
      const result = [];
      for (let i = 0; i < lines.length; i += 2)
        result.push([JSON.parse(lines[i]), JSON.parse(lines[i + 1])]);
      return result;
    });
    const error = items.find(([header]) => header.type === "event")[1];
    assert.deepEqual(error.exception.values[0].mechanism, {
      type: "auto.http.cloudflare",
      handled: false,
      is_exception_group: true,
    });
    const spans = items
      .filter(([header]) => header.type === "span")
      .flatMap(([, body]) => body.items);
    assert.equal(spans.length, 3);
    assert.ok(spans.some((span) => span.is_segment));
    for (const span of spans) {
      assert.equal(span.name, "update.request");
      assert.equal(span.attributes.component.value, "update");
    }
  } finally {
    clearTimeout(timeout);
    await mf.dispose();
  }
});

// @concord-implements docs/feature/updates/use-case/check-updates.md
void test("a valid unsampled parent suppresses spans while errors still deliver", async () => {
  const envelopes = [];
  let delivered;
  const delivery = new Promise((resolve) => {
    delivered = resolve;
  });
  const mf = runtime(async (request) => {
    if (new URL(request.url).hostname === "api.github.com")
      return new Response(null, { status: 503 });
    envelopes.push(await request.text());
    delivered();
    return Response.json({});
  }, telemetry);
  let timeout;
  try {
    const response = await mf.dispatchFetch("https://voices.niceeval.com/", {
      headers: { "sentry-trace": "12345678901234567890123456789012-1234567890123456-0" },
    });
    await response.text();
    await Promise.race([
      delivery,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("error was not delivered")), 6000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    await mf.dispose();
  }
  assert.ok(envelopes.some((text) => text.includes('"type":"event"')));
  assert.ok(!envelopes.some((text) => text.includes('"type":"span"')));
});
