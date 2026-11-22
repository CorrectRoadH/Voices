import assert from "node:assert/strict";
import test, { after } from "node:test";
import { writeFile } from "node:fs/promises";
import { build } from "vite-plus";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

await build({ configFile: "test/telemetry.vite.config.ts" });
await build({
  configFile: "test/telemetry.vite.config.ts",
  build: {
    outDir: ".cloudflare/test-business",
    lib: { entry: "test/business.fixture.ts" },
  },
});

const evidence = new Map();
after(async () => {
  // Only synthetic protocol IDs, timestamps and fixed fields; no DSN/public key,
  // business response, request data, stack, token or arbitrary attributes.
  await writeFile(
    ".cloudflare/trace-acceptance.json",
    JSON.stringify([...evidence.values()], null, 2),
  );
});

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

function spanItems(envelopes) {
  return envelopes.flatMap((envelope) => {
    const lines = envelope.trim().split("\n");
    const envelopeHeader = JSON.parse(lines[0]);
    const items = [];
    for (let index = 1; index < lines.length; index += 2) {
      const header = JSON.parse(lines[index]);
      if (header.type !== "span") continue;
      const body = JSON.parse(lines[index + 1]);
      // Relay uses content_type to distinguish v2 containers from legacy v1 spans.
      // Inspect the serialized request, after every SDK and privacy hook has run.
      assert.deepEqual(
        header,
        {
          type: "span",
          item_count: body.items.length,
          content_type: "application/vnd.sentry.items.span.v2+json",
        },
        envelope,
      );
      assert.equal(body.version, 2);
      assert.match(envelopeHeader.trace?.public_key ?? "", /^[a-f0-9]+$/);
      for (const span of body.items)
        assert.equal(envelopeHeader.trace?.trace_id, span.trace_id, envelope);
      for (const span of body.items)
        evidence.set(span.span_id, {
          trace_id: span.trace_id,
          span_id: span.span_id,
          parent_span_id: span.parent_span_id,
          name: span.name,
          status: span.status,
          is_segment: span.is_segment,
          start_timestamp: span.start_timestamp,
          end_timestamp: span.end_timestamp,
          operation: span.attributes.operation?.value,
          outcome: span.attributes.outcome?.value,
          component: span.attributes.component?.value,
        });
      items.push(...body.items);
    }
    return items;
  });
}

// @use-case docs/feature/updates/use-case/check-updates.md
void test("successful sampled request sends a v2 span container through real SDK and workerd", async () => {
  const envelopes = [];
  let delivered;
  const delivery = new Promise((resolve) => {
    delivered = resolve;
  });
  const mf = runtime(async (request) => {
    if (new URL(request.url).hostname === "api.github.com") {
      assert.equal(request.headers.get("sentry-trace"), null);
      assert.equal(request.headers.get("baggage"), null);
      return Response.json([release]);
    }
    envelopes.push(await request.text());
    delivered();
    return Response.json({});
  }, telemetry);
  let timeout;
  try {
    const response = await mf.dispatchFetch("https://voices.niceeval.com/", {
      headers: { "sentry-trace": "12345678901234567890123456789012-1234567890123456-1" },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).latestVersion, "0.0.1");
    await Promise.race([
      delivery,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("span was not delivered")), 6000);
      }),
    ]);
    const spans = spanItems(envelopes);
    assert.equal(spans.length, 4);
    const root = spans.find((span) => span.is_segment);
    assert.deepEqual(
      new Set(spans.map((span) => span.name)),
      new Set(["update.request", "update.cache.read", "update.upstream.fetch", "update.response"]),
    );
    for (const span of spans.filter((span) => !span.is_segment)) {
      assert.equal(span.parent_span_id, root.span_id);
      assert.equal(span.trace_id, root.trace_id);
      assert.equal(span.attributes.operation.value, span.name);
      assert.ok(span.end_timestamp >= span.start_timestamp);
    }
    assert.equal(spans[0].trace_id, "12345678901234567890123456789012");
    assert.equal(root.parent_span_id, "1234567890123456");
    assert.equal(root.name, "update.request");
    assert.equal(spans[0].attributes.component.value, "update");
    assert.ok(!envelopes.some((envelope) => envelope.includes('"type":"event"')));
  } finally {
    clearTimeout(timeout);
    await mf.dispose();
  }
});

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
    return Response.json({ invalid: true });
  }, telemetry);
  let timeout;
  try {
    const response = await mf.dispatchFetch(
      `https://voices.niceeval.com/?version=1.2.3&token=${sentinel}#${sentinel}`,
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
    assert.deepEqual(event.tags, {
      component: "update",
      operation: "update.upstream.fetch",
      route: "/",
      "http.method": "GET",
      "http.status_code": 200,
    });
    assert.equal(event.transaction, "update.request");
    assert.equal(event.request.url, "https://voices.niceeval.com/?version=1.2.3&token=[Filtered]");
    assert.equal(event.exception.values[0].type, "Error");
    assert.equal(event.exception.values[0].value, "invalid releases");
    assert.ok(event.exception.values[0].stacktrace.frames.length > 0);
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
      "https://voices.niceeval.com/releases?token=PRIVATE_SENTINEL_nested_913",
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
      if (header.trace) assert.equal(header.trace.transaction, "update.request");
      assert.equal(header.private, undefined);
      const result = [];
      for (let i = 0; i < lines.length; i += 2)
        result.push([JSON.parse(lines[i]), JSON.parse(lines[i + 1])]);
      return result;
    });
    const error = items.find(([header]) => header.type === "event")[1];
    const rootError = error.exception.values.find(({ type }) => type === "TypeError");
    const cause = error.exception.values.find(({ type }) => type === "SyntaxError");
    assert.equal(rootError.value, "Cannot decode release notes");
    assert.equal(rootError.mechanism.type, "auto.http.cloudflare");
    assert.equal(rootError.mechanism.handled, false);
    assert.equal(rootError.mechanism.is_exception_group, true);
    assert.equal(rootError.mechanism.data.secret, "[Filtered]");
    assert.equal(cause.value, "Invalid document Bearer [Filtered]");
    assert.equal(error.extra.nested.secret, "[Filtered]");
    assert.equal(error.contexts.business.nested.secret, "[Filtered]");
    assert.equal(error.breadcrumbs[0].message, "Loading release notes");
    const spans = spanItems(envelopes);
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

function observation(predicate) {
  const envelopes = [];
  let resolve;
  const ready = new Promise((done) => {
    resolve = done;
  });
  return {
    envelopes,
    async receive(request) {
      envelopes.push(await request.text());
      if (predicate(envelopes)) resolve();
      return Response.json({});
    },
    async wait() {
      let timeout;
      try {
        await Promise.race([
          ready,
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error("isolated telemetry missing")), 6000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function errorItems(envelopes) {
  return envelopes.flatMap((text) => {
    const lines = text.trim().split("\n");
    const events = [];
    for (let i = 1; i < lines.length; i += 2)
      if (JSON.parse(lines[i]).type === "event") events.push(JSON.parse(lines[i + 1]));
    return events;
  });
}

// @concord-implements docs/feature/updates/use-case/check-updates.md
void test("reports unhandled errors and 5xx responses with routing tags, excluding 4xx and aborts", async () => {
  const capture = observation((envelopes) => errorItems(envelopes).length >= 2);
  const mf = runtime(
    (request) => capture.receive(request),
    telemetry,
    ".cloudflare/test-telemetry/index.js",
  );
  const url = "https://worker.test/";
  const dispatch = (fixture, method = "GET") =>
    mf.dispatchFetch(url, { method, headers: { "X-Fixture": fixture } });
  try {
    const rejected = await dispatch("client-error");
    assert.equal(rejected.status, 405);
    await rejected.text();
    for (const scenario of ["abort", "throw"]) {
      const failed = await dispatch(scenario);
      assert.equal(failed.status, 500);
      await failed.text();
    }
    const unavailable = await dispatch("server-error", "POST");
    assert.equal(unavailable.status, 503);
    await unavailable.text();
    await capture.wait();

    const events = errorItems(capture.envelopes);
    assert.equal(events.length, 2);
    const thrown = events.find((event) => event.exception);
    assert.equal(thrown.exception.values[0].type, "TypeError");
    assert.equal(thrown.exception.values[0].value, "Failed to build release manifest");
    assert.ok(thrown.exception.values[0].stacktrace.frames.length > 0);
    assert.equal(thrown.tags.route, "/");
    assert.equal(thrown.tags["http.method"], "GET");
    assert.equal(thrown.tags["http.status_code"], 500);
    const response = events.find((event) => event.message === "HTTP 503");
    assert.equal(response.tags.route, "/");
    assert.equal(response.tags["http.method"], "POST");
    assert.equal(response.tags["http.status_code"], 503);
  } finally {
    await mf.dispose();
  }
});

// @concord-implements docs/feature/updates/use-case/check-updates.md
void test("cache hit and analytics success/failure retain finite stages under the real request root", async () => {
  for (const failed of [false, true]) {
    const capture = observation(
      (envelopes) => spanItems(envelopes).filter((span) => span.is_segment).length === 2,
    );
    let upstream = 0;
    const mf = runtime(
      async (request) => {
        if (new URL(request.url).hostname === "api.github.com") {
          upstream++;
          return Response.json([release]);
        }
        return capture.receive(request);
      },
      { ...telemetry, FAIL_ANALYTICS: failed },
      ".cloudflare/test-business/index.js",
    );
    try {
      const url =
        "https://worker.test/?instanceId=f7f21b46-34e4-4b17-87db-0e39c4a283e6&version=smoke";
      const response = await mf.dispatchFetch(url, {
        headers: { "sentry-trace": "11111111111111111111111111111111-1111111111111111-1" },
      });
      assert.equal((await response.json()).latestVersion, "0.0.1");
      // Seed the actual workerd Cache API at the external cache boundary. This
      // avoids treating response completion as proof of a background put finishing.
      const caches = await mf.getCaches();
      await caches.default.put(
        "https://worker.test/__release_cache/CorrectRoadH%2FVoices",
        Response.json(
          {
            schemaVersion: 1,
            latestVersion: "0.0.1",
            releaseUrl: release.html_url,
            releasedAt: release.published_at,
            releaseNotes: release.body,
            announcements: [],
          },
          { headers: { "Cache-Control": "public, max-age=300" } },
        ),
      );
      const second = await mf.dispatchFetch(url, {
        headers: { "sentry-trace": "22222222222222222222222222222222-2222222222222222-1" },
      });
      assert.equal((await second.json()).latestVersion, "0.0.1");
      await capture.wait();
      const spans = spanItems(capture.envelopes);
      assert.equal(upstream, 1);
      for (const trace of [
        "11111111111111111111111111111111",
        "22222222222222222222222222222222",
      ]) {
        const group = spans.filter((span) => span.trace_id === trace);
        const root = group.find((span) => span.is_segment);
        const analytics = group.find((span) => span.name === "update.analytics");
        assert.equal(analytics.parent_span_id, root.span_id);
        assert.equal(analytics.status, failed ? "error" : "ok");
        assert.equal(analytics.attributes.outcome.value, failed ? "error" : "success");
        for (const span of group.filter((span) => !span.is_segment))
          assert.equal(span.parent_span_id, root.span_id);
      }
      const cached = spans.filter((span) => span.trace_id === "22222222222222222222222222222222");
      assert.ok(!cached.some((span) => span.name === "update.upstream.fetch"));
      assert.equal(
        cached.find((span) => span.name === "update.cache.read").attributes.outcome.value,
        "hit",
      );
      assert.ok(!capture.envelopes.join("\n").includes("PRIVATE_SENTINEL"));
    } finally {
      await mf.dispose();
    }
  }
});

// @concord-implements docs/feature/updates/use-case/check-updates.md
void test("parallel sampled requests isolate parent, DSC and degraded upstream error spans", async () => {
  const capture = observation(
    (envelopes) =>
      spanItems(envelopes).filter((span) => span.is_segment).length === 2 &&
      errorItems(envelopes).length === 2,
  );
  const mf = runtime(async (request) => {
    if (new URL(request.url).hostname === "api.github.com") {
      assert.equal(request.headers.get("sentry-trace"), null);
      assert.equal(request.headers.get("baggage"), null);
      return new Response(null, { status: 503 });
    }
    return capture.receive(request);
  }, telemetry);
  try {
    await Promise.all(
      ["33333333333333333333333333333333", "44444444444444444444444444444444"].map(
        async (trace) => {
          const response = await mf.dispatchFetch("https://worker.test/?session=PRIVATE_SENTINEL", {
            headers: {
              "sentry-trace": `${trace}-${trace.slice(0, 16)}-1`,
              baggage:
                "sentry-transaction=PRIVATE_SENTINEL,sentry-release=PRIVATE_SENTINEL,sentry-public_key=PRIVATE_SENTINEL,thirdparty=PRIVATE_SENTINEL,sentry-sample_rate=1",
            },
          });
          assert.equal((await response.json()).latestVersion, null);
        },
      ),
    );
    await capture.wait();
    const spans = spanItems(capture.envelopes);
    for (const trace of ["33333333333333333333333333333333", "44444444444444444444444444444444"]) {
      const group = spans.filter((span) => span.trace_id === trace);
      const root = group.find((span) => span.is_segment);
      assert.equal(root.parent_span_id, trace.slice(0, 16));
      const upstream = group.find((span) => span.name === "update.upstream.fetch");
      assert.equal(upstream.parent_span_id, root.span_id);
      assert.equal(upstream.status, "error");
      assert.equal(upstream.attributes.outcome.value, "error");
      assert.equal(group.find((span) => span.name === "update.response").status, "ok");
      const error = errorItems(capture.envelopes).find(
        (event) => event.contexts.trace.trace_id === trace,
      );
      assert.equal(error.contexts.trace.span_id, upstream.span_id);
    }
    assert.ok(!capture.envelopes.join("\n").includes("PRIVATE_SENTINEL"));
  } finally {
    await mf.dispose();
  }
});

// @concord-implements docs/feature/updates/use-case/check-updates.md
void test("missing and invalid parents create isolated local traces without trusting inbound baggage", async () => {
  for (const parent of [
    undefined,
    "0".repeat(32) + "-1234567890123456-1",
    "1".repeat(32) + "-" + "0".repeat(16) + "-1",
    "PRIVATE_SENTINEL",
    "1".repeat(32) + "-1234567890123456-2",
  ]) {
    const capture = observation((envelopes) => errorItems(envelopes).length > 0);
    const mf = runtime(async (request) => {
      if (new URL(request.url).hostname === "api.github.com")
        return new Response(null, { status: 503 });
      return capture.receive(request);
    }, telemetry);
    try {
      const response = await mf.dispatchFetch("https://worker.test/", {
        headers: {
          ...(parent ? { "sentry-trace": parent } : {}),
          baggage:
            "sentry-trace_id=11111111111111111111111111111111,sentry-public_key=PRIVATE_SENTINEL,sentry-sampled=true",
        },
      });
      await response.text();
      await capture.wait();
      const trace = errorItems(capture.envelopes)[0].contexts.trace;
      assert.match(trace.trace_id, /^[a-f0-9]{32}$/);
      assert.notEqual(trace.trace_id, "0".repeat(32));
      assert.notEqual(trace.trace_id, "1".repeat(32));
      assert.ok(!capture.envelopes.join("\n").includes("PRIVATE_SENTINEL"));
    } finally {
      await mf.dispose();
    }
  }
});

// @concord-implements docs/feature/updates/use-case/check-updates.md
void test("the existing five-second upstream timeout ends the cancelled stage and still returns announcements", async () => {
  const capture = observation(
    (envelopes) =>
      spanItems(envelopes).some((span) => span.is_segment) && errorItems(envelopes).length > 0,
  );
  let releaseUpstream;
  const hold = new Promise((resolve) => {
    releaseUpstream = resolve;
  });
  const mf = runtime(async (request) => {
    if (new URL(request.url).hostname === "api.github.com") {
      await hold;
      return Response.json([release]);
    }
    return capture.receive(request);
  }, telemetry);
  try {
    const response = await mf.dispatchFetch("https://worker.test/", {
      headers: {
        "sentry-trace": "55555555555555555555555555555555-5555555555555555-1",
      },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).latestVersion, null);
    await capture.wait();
    const upstream = spanItems(capture.envelopes).find(
      (span) => span.name === "update.upstream.fetch",
    );
    // SDK 11.12 maps its cancelled status to stream status=ok. The fixed
    // outcome preserves cancellation separately from success and upstream errors.
    assert.equal(upstream.status, "ok");
    assert.equal(upstream.attributes.outcome.value, "cancelled");
    assert.ok(upstream.end_timestamp - upstream.start_timestamp >= 4.9);
  } finally {
    releaseUpstream();
    await mf.dispose();
  }
});

// @concord-implements docs/feature/updates/use-case/check-updates.md
void test("real HTTP redirect receivers observe no trace headers and no redirected request", async () => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const seen = [];
  let status = 302;
  const receiver = createServer((request, response) => {
    seen.push({
      path: request.url,
      trace: request.headers["sentry-trace"],
      baggage: request.headers.baggage,
    });
    response.writeHead(status, {
      Location: `http://127.0.0.1:${receiver.address().port}/redirect-target`,
    });
    response.end();
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  try {
    for (const redirect of [302, 307]) {
      status = redirect;
      const capture = observation(
        (envelopes) =>
          spanItems(envelopes).some((span) => span.is_segment) && errorItems(envelopes).length > 0,
      );
      const mf = runtime(async (request) => {
        const host = new URL(request.url).hostname;
        if (host === "127.0.0.1")
          return fetch(request.url, { headers: request.headers, redirect: "manual" });
        if (host !== "api.github.com") return capture.receive(request);
        // The broker returns the receiver's redirect to workerd, where the
        // production fetch's own redirect mode decides whether another hop runs.
        return fetch(`http://127.0.0.1:${receiver.address().port}/github`, {
          headers: request.headers,
          redirect: "manual",
        });
      }, telemetry);
      try {
        const response = await mf.dispatchFetch("https://worker.test/", {
          headers: {
            "sentry-trace": "66666666666666666666666666666666-6666666666666666-1",
            baggage: "thirdparty=PRIVATE_SENTINEL",
          },
        });
        assert.equal((await response.json()).latestVersion, null);
        await capture.wait();
      } finally {
        await mf.dispose();
      }
    }
    assert.deepEqual(seen, [
      { path: "/github", trace: undefined, baggage: undefined },
      { path: "/github", trace: undefined, baggage: undefined },
    ]);
  } finally {
    receiver.closeAllConnections();
    await new Promise((resolve) => receiver.close(resolve));
  }
});
