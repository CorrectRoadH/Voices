// @concord-file
// @concord-implements docs/feature/updates/use-case/check-updates.md
import { recordUpdateRequest } from "./analytics.ts";
import content from "../content/announcements.json";
import {
  buildManifest,
  validateAnnouncements,
  type Release,
  type Manifest,
  version,
  compare,
} from "./manifest.ts";

export interface Env {
  GITHUB_REPO: string;
  UPDATE_REQUESTS?: AnalyticsEngineDataset;
  GITHUB_TOKEN?: string;
}
const announcements = validateAnnouncements(content);
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };
const json = (body: unknown, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache },
  });

async function releases(env: Env): Promise<Release[]> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPO)) throw new Error("invalid repository");
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "voices-update-worker",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  let latest: Release | undefined;
  const signal = AbortSignal.timeout(5000);
  for (let page = 1; page <= 10; page++) {
    const response = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/releases?per_page=100&page=${page}`,
      {
        headers,
        signal,
        redirect: "manual",
        // Reuse public GitHub responses across clients; never cache a rate-limit failure.
        cf: { cacheEverything: true, cacheTtlByStatus: { "200": 300, "300-599": -1 } },
      },
    );
    if (!response.ok) {
      console.warn("GitHub release lookup failed", {
        status: response.status,
        rateLimitRemaining: response.headers.get("X-RateLimit-Remaining"),
      });
      throw new Error("GitHub unavailable");
    }
    const value: unknown = await response.json();
    if (
      !Array.isArray(value) ||
      value.some(
        (r) =>
          !r ||
          typeof r.tag_name !== "string" ||
          typeof r.draft !== "boolean" ||
          typeof r.prerelease !== "boolean",
      )
    )
      throw new Error("invalid releases");
    for (const item of value as Release[]) {
      const candidate = version(item.tag_name);
      if (
        !item.draft &&
        !item.prerelease &&
        candidate &&
        (!latest || compare(candidate, version(latest.tag_name)!) > 0)
      )
        latest = item;
    }
    if (!response.headers.get("Link")?.includes('rel="next"')) return latest ? [latest] : [];
  }
  throw new Error("incomplete release history");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/") return json({ error: "not_found" }, 404);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    ctx.waitUntil(
      Promise.resolve().then(() =>
        recordUpdateRequest(env.UPDATE_REQUESTS, url.searchParams, request),
      ),
    );
    // Cache only the release snapshot; announcements are filtered at request time.
    const key = new Request(`${url.origin}/__release_cache/${encodeURIComponent(env.GITHUB_REPO)}`);
    let releaseManifest: Manifest | undefined;
    const cache = typeof caches === "undefined" ? undefined : caches.default;
    try {
      const hit = await cache?.match(key);
      if (hit) releaseManifest = await hit.json<Manifest>();
    } catch {
      /* cache is optional */
    }
    if (!releaseManifest) {
      try {
        releaseManifest = buildManifest(await releases(env), []);
        if (releaseManifest.latestVersion && cache)
          ctx.waitUntil(
            cache.put(key, json(releaseManifest, 200, "public, max-age=300")).catch(() => {}),
          );
      } catch (error) {
        // Never log request URLs, identities, credentials, or upstream bodies.
        console.warn("Release lookup unavailable", error instanceof Error ? error.name : "unknown");
        /* Keep announcements available when releases are unknown. */
      }
    }
    const noticeManifest = buildManifest([], announcements);
    const result = {
      ...noticeManifest,
      ...(releaseManifest ?? {}),
      announcements: noticeManifest.announcements,
    };
    if (new TextEncoder().encode(JSON.stringify(result)).length > 262144)
      return json(noticeManifest);
    // Browsers must not cache time-bounded announcements past their expiry.
    return json(result);
  },
};
