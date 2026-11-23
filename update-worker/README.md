# Voices update worker

Cloudflare Worker serving `GET /`: latest stable GitHub release plus bundled announcements. The application fetches this endpoint from Go; browsers use the authenticated admin API. Installation telemetry is enabled by default in Voices; UPDATE_TELEMETRY=false opts out. The Worker accepts only a random installation UUID, version, Go version, OS, architecture and optional locale; Cloudflare supplies country. No recording, transcript, account or IP is stored in the dataset. Public GitHub responses and successful release snapshots are cached for five minutes; upstream redirects and failures are not cached. GitHub release changes require no Worker redeploy; announcement changes require redeploy.

## Local checks

From the repository root:

```sh
vp -C update-worker install --frozen-lockfile
vp -C update-worker run check
vp -C update-worker run test
vp -C update-worker run test:runtime # cf build + real workerd tests; does not publish
vp -C update-worker run dev
```

## Deployment

After review and authorization, use the `Deploy update worker` GitHub workflow on `main`. Configure the `update-worker-production` environment with `CLOUDFLARE_API_TOKEN` (limit to the target account/Worker) and `CLOUDFLARE_ACCOUNT_ID`. A manual CLI alternative is `vp -C update-worker run deploy` with those environment variables. The custom domain voices.niceeval.com and Analytics Engine dataset voices_update_requests are declared in cloudflare.config.ts; no account ID or credentials are embedded.

The application defaults to `UPDATE_URL=https://voices.niceeval.com/`. An explicitly empty `UPDATE_URL` disables checks and statistics. Restart after changing deployment settings. Trust the endpoint operator: they control the notices and HTTPS links shown to administrators. Optional Worker secret `GITHUB_TOKEN` raises GitHub API rate limits; it is never an application/browser setting.

After an authorized deployment, verify `curl -fsS "$UPDATE_URL"` returns `schemaVersion: 1` and an `announcements` array. Before the first GitHub Release, `latestVersion` is null; the application correctly displays an unknown/failed version check while still showing announcements.

## Announcements

Edit `content/announcements.json`, then check/test before deploying. Initially empty to avoid publishing invented notices. Example entry:

```json
{
  "id": "upgrade-0-2-0",
  "title": "升级前请备份",
  "body": "请先备份 PostgreSQL，再更新镜像。",
  "severity": "warning",
  "publishedAt": "2026-10-18T00:00:00Z",
  "expiresAt": "2026-11-18T00:00:00Z",
  "link": "https://github.com/CorrectRoadH/Voices/releases"
}
```

IDs are unique. Severity is `info`, `warning`, or `critical`; dates are UTC RFC3339. Use null for no expiry/link. Future and expired notices are hidden. An empty array retracts all notices. Content is plain text, including any Markdown syntax; HTML is never executed. Limits: 20 notices, 64 KiB total JSON; ID/title/body at most 100/200/4000 UTF-16 code units. Release notes truncate at 32000 code units with an explicit notice and a link to the full release. Total response is at most 256 KiB.

The release lookup covers at most 1000 GitHub releases and refuses an incomplete history. Only stable three-part versions (components ≤ 4294967295) are eligible; draft and prerelease entries are excluded. GitHub failures leave announcements available and return an unknown release. Cloudflare Cache API caches only successful release snapshots, not per-client responses or announcements.

[Contract](../docs/feature/updates/architecture/service.md)

## Installation statistics

`UPDATE_TELEMETRY` defaults to `true`; set `false` to keep updates without statistics. Restore mode never sends statistics. PostgreSQL owns the singleton `instance_identity`; it is independent of process/task lease IDs and survives restart, upgrade and restore. For a database cloned into an independent installation, run `UPDATE instance_identity SET instance_id=gen_random_uuid() WHERE id=1` before starting that clone. Never rotate the original installation as part of ordinary recovery.

Statistics accompany actual update checks only. Missing/malformed IDs and versions are ignored; Analytics Engine failures never fail the manifest. The dataset maps index1 to installation UUID and blob1..6 to version, Go version, OS, architecture, locale and country. Grafana's Voices dashboard reuses `cf-ae`; sampled distinct installations are observations, not exact users. Version/environment buckets cover values observed during the period, so an installation may occupy several buckets. Multiple replicas increase request counts. Version `smoke` is reserved for acceptance probes and excluded from the dashboard.

The project uses pinned `cf` plus the Cloudflare Vite plugin for dev/build/deploy. `vp -C update-worker exec cf deploy --prebuilt` publishes an already checked build. OAuth credentials stay in the CLI profile; CI uses its existing Cloudflare environment secrets.

## Official API monitoring

This dedicated public update service fixes its public DSN in source (`instaai/voices-update`, `component=update`). Desktop recording and Voices deployments operated by other people are excluded. The existing Vite production build mode enables initialization, with `SENTRY_ENVIRONMENT` defaulting to `production`. Development/test builds and explicit development/test/preview environments remain disabled. Deployments supply `SENTRY_RELEASE=update@<git-sha>`; use the same release for sourcemaps. Do not put `SENTRY_AUTH_TOKEN` in source. Use an explicit test/preview environment to disable delivery.

The official SDK caches one client per isolate, isolates request scopes, and flushes via execution-context `waitUntil`. Request traces sample at 0.01 and honor parent sampling; errors are not sampled. No outgoing trace headers reach GitHub. Error events retain the original exception type, message, cause chain, stack, and business details. They include the route template, HTTP method, response status, and sanitized request URL. The error filters replace credentials in headers, query parameters, structured fields, and strings with `[Filtered]`. SDK personal-data collection stays disabled and request and response bodies are never attached. The Worker reports unhandled errors and 5xx responses. Client errors and disconnects do not generate error events. A handled upstream failure still reports its exception with the update endpoint’s fallback HTTP 200 status. The span and envelope header filters preserve the fixed operation names and existing telemetry fields. Explicit fixed logs and operation metrics are filtered at both early hooks and final transport. Ingestion failure preserves the manifest response.

`vp run test:worker:runtime` builds the real Worker plus a separate test-only SDK fixture, and uses workerd with an explicit isolated ingestion boundary. It verifies entire envelopes, nested data and root/child spans without contacting Sentry; the test fixture is never part of the deploy artifact. `vp -C update-worker run test` also checks the production gate. Builds inject debug IDs and emit local sourcemaps without uploading when `SENTRY_AUTH_TOKEN` is absent. A production build with that private token requires `SENTRY_RELEASE=update@<full-git-sha>`, uploads to the fixed project, and deletes maps after upload. Runtime release must match. Actual upload and production event/trace readback belong to the separately authorized deployment; local workerd verifies the error event retains legal debug images. Keep maps out of public static hosting.

Business phases retain the finite names `update.cache.read`, `update.upstream.fetch`, `update.response`, and `update.analytics` below the SDK-owned `update.request`. Cache reads include JSON decoding. Upstream spans include pagination and body parsing, with a shared four-second deadline that leaves time for the client to receive the response within five seconds. Response spans cover manifest composition, while the SDK owns HTTP completion. Analytics spans cover validated writes inside the existing `waitUntil`; failures still leave updates available. Cache writes keep their existing scheduling without inventing an unregistered operation. Fixed `outcome` distinguishes success, cache hit/miss, failure and cancellation; SDK 11.12 encodes cancelled streamed spans with `status=ok`, so cancellation is identified by `outcome=cancelled`.

The SDK sees only validated nonzero incoming trace/span IDs and no inbound baggage; the handler receives the original Request. The final transport repeats payload/header/typed-attribute sanitization after all envelope listeners, including direct SDK envelope sends, while retaining the official transport's buffering and flush behavior. Worker CPU profiling is unsupported: profile/profile_chunk, arbitrary logs/metrics, Replay, Session, Cron and unknown items remain rejected. No profiling dependency, manifest or additional enable variable is used. Runtime tests also exercise real loopback HTTP redirect receivers, parallel requests, cache hits, analytics failure and upstream timeout. Synthetic final-transport span evidence is written to `.cloudflare/trace-acceptance.json`, outside the deploy bundle; it contains fixed fields and protocol IDs only.

## Fixed logs and operation metrics

`update.request` records exactly one `app.operation.count` (counter=1) and `app.operation.duration` (distribution in milliseconds) per request handled by the SDK (OPTIONS/HEAD retain its existing bypass), independently of trace sampling. Subphases do not double-count the request. Fixed outcomes are success/error/cancelled/rejected; upstream degradation still returns the original successful announcement response. Only actual caught degradation emits `operation.degraded`/warn; unhandled top-level failures emit `operation.failed`/error. Existing console logs are not forwarded and requests do not masquerade as process startup/shutdown.

Final transport rebuilds SDK v2 log/trace_metric containers and typed attributes after scope merging and all envelope listeners. Synchronous sanitization adds no separate queue; the official Cloudflare flush owns delivery. `sendClientReports=true` records SDK losses and a finite client_report whitelist is present, but SDK 11.12 Cloudflare exposes no public automatic report drain. Automatic client_report delivery remains incomplete; no protected method or replacement aggregation is used. Worker has no browserSession or scheduler; session/sessions/check_in/Replay remain denied.

`vp -C update-worker run test:quality` uses two small map-free fixtures with the installed SDK and actual handler, real workerd and an isolated loopback HTTP ingestion receiver. It does not run the production build or contact Sentry. The full `vp run test:worker:runtime` build remains a separate gate. Evidence in `.cloudflare/quality-acceptance.json` contains synthetic protocol records without DSN or original business data.
