# Voices update worker

Cloudflare Worker serving `GET /`: latest stable GitHub release plus bundled announcements. The application fetches this endpoint from Go; browsers use the authenticated admin API. No instance telemetry is collected. GitHub release changes require no Worker redeploy (release cache lasts five minutes); announcement changes require redeploy.

## Local checks

From the repository root:

```sh
pnpm --dir update-worker install --frozen-lockfile
pnpm --dir update-worker check
pnpm --dir update-worker test
pnpm --dir update-worker build   # Wrangler dry-run; does not publish
pnpm --dir update-worker dev
```

## Deployment

After review and authorization, use the `Deploy update worker` GitHub workflow on `main`. Configure the `update-worker-production` environment with `CLOUDFLARE_API_TOKEN` (limit to the target account/Worker) and `CLOUDFLARE_ACCOUNT_ID`. A manual CLI alternative is `pnpm --dir update-worker deploy` with those environment variables. No custom domain or account ID is embedded in this repository.

Use the HTTPS URL returned by Wrangler as the application's `UPDATE_URL`, then restart Voices. An empty `UPDATE_URL` disables checks. Trust the endpoint operator: they control the notices and HTTPS links shown to administrators. Optional Worker secret `GITHUB_TOKEN` raises GitHub API rate limits; it is never an application/browser setting.

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
