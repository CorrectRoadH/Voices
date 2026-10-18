# Voices update worker

Cloudflare Worker serving `GET /`: latest stable GitHub release plus bundled announcements. The application fetches this endpoint from Go; browsers use the authenticated admin API. Installation telemetry is enabled by default in Voices; UPDATE_TELEMETRY=false opts out. The Worker accepts only a random installation UUID, version, Go version, OS, architecture and optional locale; Cloudflare supplies country. No recording, transcript, account or IP is stored in the dataset. GitHub release changes require no Worker redeploy (release cache lasts five minutes); announcement changes require redeploy.

## Local checks

From the repository root:

```sh
pnpm --dir update-worker install --frozen-lockfile
pnpm --dir update-worker check
pnpm --dir update-worker test
pnpm --dir update-worker build   # cf build; does not publish
pnpm --dir update-worker dev
```

## Deployment

After review and authorization, use the `Deploy update worker` GitHub workflow on `main`. Configure the `update-worker-production` environment with `CLOUDFLARE_API_TOKEN` (limit to the target account/Worker) and `CLOUDFLARE_ACCOUNT_ID`. A manual CLI alternative is `pnpm --dir update-worker deploy` with those environment variables. The custom domain voices.niceeval.com and Analytics Engine dataset voices_update_requests are declared in cloudflare.config.ts; no account ID or credentials are embedded.

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

[Contract](../docs/research/release-updates/README.md)

## Installation statistics

`UPDATE_TELEMETRY` defaults to `true`; set `false` to keep updates without statistics. Restore mode never sends statistics. PostgreSQL owns the singleton `instance_identity`; it is independent of process/task lease IDs and survives restart, upgrade and restore. For a database cloned into an independent installation, run `UPDATE instance_identity SET instance_id=gen_random_uuid() WHERE id=1` before starting that clone. Never rotate the original installation as part of ordinary recovery.

Statistics accompany actual update checks only. Missing/malformed IDs and versions are ignored; Analytics Engine failures never fail the manifest. The dataset maps index1 to installation UUID and blob1..6 to version, Go version, OS, architecture, locale and country. Grafana's Voices dashboard reuses `cf-ae`; sampled distinct installations are observations, not exact users. Version/environment buckets cover values observed during the period, so an installation may occupy several buckets. Multiple replicas increase request counts. Version `smoke` is reserved for acceptance probes and excluded from the dashboard.

The project uses pinned `cf` plus the Cloudflare Vite plugin for dev/build/deploy. `pnpm --dir update-worker exec cf deploy --prebuilt` publishes an already checked build. OAuth credentials stay in the CLI profile; CI uses its existing Cloudflare environment secrets.
