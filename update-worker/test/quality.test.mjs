import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { build } from "vite-plus";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

// Small, map-free SDK fixtures only. This is deliberately not the production cf build gate.
for (const [name, entry] of [
  ["quality", "test/quality.fixture.ts"],
  ["quality-business", "test/business.fixture.ts"],
]) {
  await build({
    configFile: "test/telemetry.vite.config.ts",
    build: {
      outDir: `.cloudflare/test-${name}`,
      sourcemap: false,
      lib: { entry },
    },
  });
}
const evidence = [];
after(() => writeFile(".cloudflare/quality-acceptance.json", JSON.stringify(evidence, null, 2)));
const sentinel = "PRIVATE_SENTINEL";
const env = {
  SENTRY_ENVIRONMENT: "production",
  SENTRY_RELEASE: "update@quality-test",
  GITHUB_REPO: "CorrectRoadH/Voices",
};
function items(texts, type) {
  return texts.flatMap((text) => {
    assert.ok(!text.includes(sentinel), "final wire retained a sentinel");
    const lines = text.trim().split("\n");
    const result = [];
    for (let i = 1; i < lines.length; i += 2) {
      const header = JSON.parse(lines[i]);
      const body = JSON.parse(lines[i + 1]);
      assert.ok(["span", "event", "log", "trace_metric", "client_report"].includes(header.type));
      if (header.type !== type) continue;
      if (["log", "trace_metric"].includes(type)) {
        assert.equal(body.version, 2);
        assert.equal(header.item_count, body.items.length);
        assert.equal(
          header.content_type,
          type === "log"
            ? "application/vnd.sentry.items.log+json"
            : "application/vnd.sentry.items.trace-metric+json",
        );
        result.push(...body.items);
      } else result.push(body);
    }
    return result;
  });
}
async function runtime(script, predicate, extra = {}, upstreamStatus = 503, failIngestion = false) {
  const texts = [];
  let ready;
  const delivered = new Promise((resolve) => {
    ready = resolve;
  });
  const receiver = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    texts.push(text);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("{}");
    if (predicate(texts)) ready();
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: `.cloudflare/test-${script}/index.js`,
      compatibilityDate: "2026-10-01",
      compatibilityFlags: ["nodejs_compat"],
      bindings: { ...env, ...extra },
      async outboundService(request) {
        if (["api.github.com", "external.test"].includes(new URL(request.url).hostname)) {
          assert.equal(request.headers.get("sentry-trace"), null);
          assert.equal(request.headers.get("baggage"), null);
          return new Response(upstreamStatus === 200 ? "[]" : null, { status: upstreamStatus });
        }
        if (failIngestion) {
          texts.push(await request.text());
          if (predicate(texts)) ready();
          throw new Error("isolated ingestion unavailable");
        }
        // Real serialized SDK transport to a real HTTP ingestion receiver; no real Sentry connection.
        return fetch(`http://127.0.0.1:${receiver.address().port}/ingest`, {
          method: "POST",
          body: await request.text(),
        });
      },
    }),
  );
  return {
    mf,
    texts,
    async wait() {
      let timer;
      try {
        await Promise.race([
          delivered,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("SDK log/metric flush missing")), 4000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      await mf.dispose();
      receiver.closeAllConnections();
      await new Promise((resolve) => receiver.close(resolve));
    },
  };
}

// @concord-implements docs/feature/updates/use-case/check-updates.md
void test("actual update handler records exactly one count/duration under unsampled parent and one degradation log", async () => {
  const r = await runtime(
    "quality-business",
    (texts) => items(texts, "trace_metric").length === 2 && items(texts, "log").length === 1,
  );
  try {
    const response = await r.mf.dispatchFetch("https://worker.test/?private=PRIVATE_SENTINEL", {
      headers: { "sentry-trace": "77777777777777777777777777777777-7777777777777777-0" },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).latestVersion, null);
    await r.wait();
    const metrics = items(r.texts, "trace_metric");
    const logs = items(r.texts, "log");
    assert.equal(items(r.texts, "span").length, 0);
    assert.equal(metrics.filter((x) => x.name === "app.operation.count").length, 1);
    assert.equal(metrics.find((x) => x.name === "app.operation.count").value, 1);
    assert.equal(metrics.find((x) => x.name === "app.operation.duration").unit, "millisecond");
    for (const metric of metrics) {
      assert.equal(metric.attributes.operation.value, "update.request");
      assert.equal(metric.attributes.outcome.value, "success");
      assert.equal(metric.trace_id, "77777777777777777777777777777777");
      assert.ok(Number.isFinite(metric.timestamp));
    }
    assert.equal(logs[0].body, "operation.degraded");
    assert.equal(logs[0].level, "warn");
    assert.equal(logs[0].attributes.operation.value, "update.upstream.fetch");
    evidence.push({ scenario: "real-handler-unsampled", metrics, logs });
  } finally {
    await r.close();
  }
});

// @concord-implements docs/feature/updates/use-case/check-updates.md
void test("real SDK scope/global/isolation/call and late listener fields are removed from log/trace_metric wire", async () => {
  const r = await runtime(
    "quality",
    (texts) => items(texts, "trace_metric").length === 2 && items(texts, "log").length === 1,
  );
  try {
    await (await r.mf.dispatchFetch("https://worker.test/?mode=scope")).text();
    await r.wait();
    const metrics = items(r.texts, "trace_metric");
    const logs = items(r.texts, "log");
    for (const record of [...logs, ...metrics]) {
      assert.equal(record.private, undefined);
      assert.equal(record.attributes.private, undefined);
      assert.equal(record.attributes["scope.private"], undefined);
      assert.equal(record.attributes.component.value, "update");
      assert.equal(record.attributes["sentry.sdk.version"].value, "11.13.0");
    }
    assert.equal(logs[0].severity_number, 13);
    evidence.push({ scenario: "scope-final-transport", metrics, logs });
  } finally {
    await r.close();
  }
});

// @concord-implements docs/feature/updates/use-case/check-updates.md
void test("top wrapper success/rejection/error/cancellation counts once independently of trace sampling", async () => {
  for (const [mode, outcome] of [
    ["ok", "success"],
    ["reject", "rejected"],
    ["throw", "error"],
    ["cancel", "cancelled"],
  ]) {
    const failed = ["throw", "cancel"].includes(mode);
    const r = await runtime(
      "quality",
      (texts) =>
        items(texts, "trace_metric").length === 2 && (!failed || items(texts, "log").length === 1),
      {},
      200,
    );
    try {
      await (await r.mf.dispatchFetch(`https://worker.test/?mode=${mode}`)).text();
      await r.wait();
      const metrics = items(r.texts, "trace_metric");
      const logs = items(r.texts, "log");
      assert.equal(metrics.length, 2);
      for (const metric of metrics) {
        assert.equal(metric.attributes.outcome.value, outcome);
        assert.ok(metric.value >= 0);
      }
      assert.equal(logs.length, failed ? 1 : 0);
      if (failed) {
        assert.equal(logs[0].body, "operation.failed");
        assert.equal(logs[0].severity_number, 17);
      }
      evidence.push({ scenario: `wrapper-${mode}`, metrics, logs });
    } finally {
      await r.close();
    }
  }
});

// @concord-implements docs/feature/updates/use-case/check-updates.md
void test("disabled dedicated Worker emits no quality telemetry", async () => {
  const r = await runtime("quality-business", () => false, { SENTRY_ENVIRONMENT: "test" });
  try {
    const response = await r.mf.dispatchFetch("https://worker.test/");
    assert.equal(response.status, 200);
    await response.text();
  } finally {
    await r.close();
  }
  assert.deepEqual(r.texts, []);
});

// @concord-implements docs/feature/updates/use-case/check-updates.md
void test("Cloudflare public flush delivers metrics but has no automatic client_report drain in 11.13", async () => {
  const r = await runtime("quality", (texts) => items(texts, "trace_metric").length === 2);
  try {
    await (await r.mf.dispatchFetch("https://worker.test/?mode=reports")).text();
    await r.wait();
  } finally {
    await r.close();
  }
  assert.equal(items(r.texts, "client_report").length, 0);
  evidence.push({
    scenario: "client-report-no-public-drain",
    automaticReports: 0,
    limitation: true,
  });
});

// @concord-implements docs/feature/updates/use-case/check-updates.md
void test("quality transport failure preserves the real update response without recursive reports", async () => {
  const r = await runtime(
    "quality-business",
    (texts) => items(texts, "trace_metric").length === 2,
    {},
    503,
    true,
  );
  try {
    const response = await r.mf.dispatchFetch("https://worker.test/", {
      headers: { "sentry-trace": "88888888888888888888888888888888-8888888888888888-0" },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).latestVersion, null);
    await r.wait();
  } finally {
    await r.close();
  }
  assert.ok(r.texts.length <= 4);
  assert.equal(items(r.texts, "client_report").length, 0);
  evidence.push({ scenario: "ingestion-failure", responseStatus: 200, attempts: r.texts.length });
});

// @concord-implements docs/feature/updates/use-case/check-updates.md
void test("real route rejection counts once while protocol OPTIONS/HEAD retain SDK bypass", async () => {
  for (const [method, path, status] of [
    ["GET", "/missing", 404],
    ["POST", "/", 405],
  ]) {
    const r = await runtime(
      "quality-business",
      (texts) => items(texts, "trace_metric").length === 2,
    );
    try {
      const response = await r.mf.dispatchFetch(`https://worker.test${path}`, {
        method,
        headers: { "sentry-trace": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-aaaaaaaaaaaaaaaa-0" },
      });
      assert.equal(response.status, status);
      await response.text();
      await r.wait();
      for (const metric of items(r.texts, "trace_metric"))
        assert.equal(metric.attributes.outcome.value, "rejected");
      assert.equal(items(r.texts, "log").length, 0);
    } finally {
      await r.close();
    }
  }
  for (const method of ["OPTIONS", "HEAD"]) {
    const r = await runtime("quality-business", () => false);
    try {
      await (await r.mf.dispatchFetch("https://worker.test/", { method })).text();
    } finally {
      await r.close();
    }
    assert.deepEqual(r.texts, []);
  }
});
