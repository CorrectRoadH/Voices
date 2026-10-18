import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import worker from "../src/index.ts";
import content from "../content/announcements.json";
import { buildManifest, validateAnnouncements } from "../src/manifest.ts";
vi.mock("../content/announcements.json", () => ({
  default: [
    {
      id: "n",
      title: "Notice",
      body: "hello",
      severity: "info",
      publishedAt: "2026-01-01T00:00:00Z",
      expiresAt: null,
      link: null,
    },
  ],
}));
const env = { GITHUB_REPO: "CorrectRoadH/Voices" };
const pending: Promise<unknown>[] = [];
const ctx = {
  waitUntil(p: Promise<unknown>) {
    pending.push(p);
  },
} as ExecutionContext;
const release = (tag_name: string, extra = {}) => ({
  tag_name,
  draft: false,
  prerelease: false,
  body: "notes",
  html_url: "https://github.com/CorrectRoadH/Voices/releases/tag/" + tag_name,
  published_at: "2026-01-01T00:00:00Z",
  ...extra,
});
const notice = {
  id: "n",
  title: "Notice",
  body: "hello",
  severity: "info" as const,
  publishedAt: "2026-01-01T00:00:00Z",
  expiresAt: null,
  link: null,
};
afterEach(async () => {
  await Promise.all(pending.splice(0));
  vi.unstubAllGlobals();
});

// @use-case docs/feature/updates/use-case/check-updates.md
describe("update worker", () => {
  it("validates the actual deployed announcement bundle", async () => {
    const actual = await vi.importActual<{ default: unknown }>("../content/announcements.json");
    expect(() => validateAnnouncements(actual.default)).not.toThrow();
  });
  it("selects the highest stable release, filters windows and bounds notes", () => {
    const m = buildManifest(
      [
        release("v1.9.0"),
        release("v2.0.0", { draft: true }),
        release("v3.0.0", { prerelease: true }),
        release("v4.0.0-beta"),
        release("v1.10.0", { body: "文".repeat(40000) }),
      ],
      [
        notice,
        { ...notice, id: "future", publishedAt: "2099-01-01T00:00:00Z" },
        { ...notice, id: "expired", expiresAt: "2026-01-02T00:00:00Z" },
      ],
      Date.parse("2026-10-01"),
    );
    expect(m.latestVersion).toBe("1.10.0");
    expect(m.announcements.map((a) => a.id)).toEqual(["n"]);
    expect(m.releaseNotes).toContain("已截断");
    expect(new TextEncoder().encode(JSON.stringify(m)).length).toBeLessThan(262144);
  });
  it("rejects bad dates, duplicate IDs, insecure links and oversize content", () => {
    for (const entries of [
      [notice, notice],
      [{ ...notice, link: "javascript:alert(1)" }],
      [{ ...notice, publishedAt: "2026-02-30T00:00:00Z" }],
      [{ ...notice, body: "a".repeat(4001) }],
      [{ ...notice, expiresAt: "2025-01-01T00:00:00Z" }],
    ])
      expect(() => validateAnnouncements(entries)).toThrow();
  });
  it("serves its real handler without forwarding client query or telemetry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json([release("v1.0.0")]));
    vi.stubGlobal("fetch", fetchMock);
    const response = await worker.fetch(
      new Request("https://updates.example/?instanceId=private&version=dev"),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).latestVersion).toBe("1.0.0");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/CorrectRoadH/Voices/releases?per_page=100&page=1",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("returns unknown version on upstream failure, preserving independently valid announcements", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const response = await worker.fetch(new Request("https://updates.example/"), env, ctx);
    const m = (await response.json()) as any;
    expect(m.latestVersion).toBeNull();
    expect(m.announcements).toEqual(
      buildManifest([], validateAnnouncements(content)).announcements,
    );
    expect(m.announcements).toHaveLength(1);
    expect(buildManifest([], [notice]).announcements).toEqual([notice]);
  });
  it("paginates before selecting the maximum, refusing incomplete history", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json([release("v1.0.0")], {
          headers: { Link: '<https://api.github.com/next>; rel="next"' },
        }),
      )
      .mockResolvedValueOnce(Response.json([release("v9.0.0")]));
    vi.stubGlobal("fetch", mock);
    expect(
      (
        (await (
          await worker.fetch(new Request("https://updates.example/"), env, ctx)
        ).json()) as any
      ).latestVersion,
    ).toBe("9.0.0");
    mock.mockImplementation(async () =>
      Response.json([release("v1.0.0")], {
        headers: { Link: '<https://api.github.com/next>; rel="next"' },
      }),
    );
    expect(
      (
        (await (
          await worker.fetch(new Request("https://updates.example/"), env, ctx)
        ).json()) as any
      ).latestVersion,
    ).toBeNull();
  });
  it("caches upstream releases and tolerates cache errors", async () => {
    const store = new Map<string, Response>();
    const cache = {
      match: async (r: Request) => store.get(r.url)?.clone(),
      put: async (r: Request, v: Response) => {
        store.set(r.url, v.clone());
      },
    };
    vi.stubGlobal("caches", { default: cache });
    const mock = vi.fn().mockImplementation(async () => Response.json([release("v1.0.0")]));
    vi.stubGlobal("fetch", mock);
    await worker.fetch(new Request("https://updates.example/"), env, ctx);
    await Promise.all(pending);
    await worker.fetch(new Request("https://updates.example/?version=other"), env, ctx);
    expect(mock).toHaveBeenCalledTimes(1);
    vi.stubGlobal("caches", {
      default: {
        match: async () => {
          throw Error();
        },
        put: async () => {
          throw Error();
        },
      },
    });
    expect((await worker.fetch(new Request("https://updates.example/"), env, ctx)).status).toBe(
      200,
    );
  });
  it("rejects unknown paths and writes", async () => {
    expect((await worker.fetch(new Request("https://updates.example/no"), env, ctx)).status).toBe(
      404,
    );
    expect(
      (await worker.fetch(new Request("https://updates.example/", { method: "POST" }), env, ctx))
        .status,
    ).toBe(405);
    expect(
      (await worker.fetch(new Request("https://updates.example/", { method: "OPTIONS" }), env, ctx))
        .status,
    ).toBe(204);
  });
});

// @use-case docs/feature/updates/use-case/check-updates.md
describe("installation analytics", () => {
  const id = "f7f21b46-34e4-4b17-87db-0e39c4a283e6";
  it("records validated fields even on cached manifests, without forwarding query", async () => {
    const writeDataPoint = vi.fn();
    vi.stubGlobal("caches", { default: { match: vi.fn().mockResolvedValue(Response.json(buildManifest([release("v1.0.0")], []))) } });
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const request = new Request(`https://voices.niceeval.com/?instanceId=${id.toUpperCase()}&version=dev&goVersion=go1.26&os=linux&arch=arm64&locale=bad%20value&secret=ignored`);
    Object.defineProperty(request, "cf", { value: { country: "SG" } });
    expect((await worker.fetch(request, { ...env, UPDATE_REQUESTS: { writeDataPoint } as any }, ctx)).status).toBe(200);
    await Promise.all(pending.splice(0));
    expect(writeDataPoint).toHaveBeenCalledExactlyOnceWith({ indexes: [id], blobs: ["dev", "go1.26", "linux", "arm64", "", "SG"], doubles: [] });
    expect(upstream).not.toHaveBeenCalled();
  });
  it("drops incomplete and invalid identities and isolates analytics failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json([])));
    const writeDataPoint = vi.fn(() => { throw new Error("unavailable"); });
    for (const query of ["", `instanceId=${id}`, "instanceId=bad&version=dev", `instanceId=${id}&version=${"x".repeat(65)}`]) {
      expect((await worker.fetch(new Request(`https://voices.niceeval.com/?${query}`), { ...env, UPDATE_REQUESTS: { writeDataPoint } as any }, ctx)).status).toBe(200);
    }
    await Promise.all(pending.splice(0));
    expect(writeDataPoint).not.toHaveBeenCalled();
    const response = await worker.fetch(new Request(`https://voices.niceeval.com/?instanceId=${id}&version=smoke`), { ...env, UPDATE_REQUESTS: { writeDataPoint } as any }, ctx);
    await Promise.all(pending.splice(0));
    expect(response.status).toBe(200);
    expect(writeDataPoint).toHaveBeenCalledOnce();
  });
});
