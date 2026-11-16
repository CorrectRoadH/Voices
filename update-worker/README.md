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

The official SDK caches one client per isolate, isolates request scopes, and flushes via execution-context `waitUntil`. Request traces sample at 0.01 and honor parent sampling; errors are not sampled. No outgoing trace headers reach GitHub. Final error/span hooks rebuild allowed fields, replace exception text, and remove identity, query, headers, bodies, arbitrary nested data and span attributes. A `beforeEnvelope` integration also rebuilds the final header/DSC, removes external operation names and drops payload classes outside errors/spans. Log/metric hooks drop all records. Ingestion failure preserves the manifest response.

`vp run test:worker:runtime` builds the real Worker plus a separate test-only SDK fixture, and uses workerd with an explicit isolated ingestion boundary. It verifies entire envelopes, nested data and root/child spans without contacting Sentry; the test fixture is never part of the deploy artifact. `vp -C update-worker run test` also checks the production gate. Builds inject debug IDs and emit local sourcemaps without uploading when `SENTRY_AUTH_TOKEN` is absent. A production build with that private token requires `SENTRY_RELEASE=update@<full-git-sha>`, uploads to the fixed project, and deletes maps after upload. Runtime release must match. Actual upload and production event/trace readback belong to the separately authorized deployment; local workerd verifies the error event retains legal debug images. Keep maps out of public static hosting.
