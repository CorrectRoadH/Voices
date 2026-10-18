// @concord-file
// @concord-implements docs/feature/updates/use-case/check-updates.md
export interface Announcement {
  id: string;
  title: string;
  body: string;
  severity: "info" | "warning" | "critical";
  publishedAt: string;
  expiresAt: string | null;
  link: string | null;
}
export interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  published_at: string;
  body: string | null;
}
export interface Manifest {
  schemaVersion: 1;
  latestVersion: string | null;
  releaseUrl: string | null;
  releasedAt: string | null;
  releaseNotes: string;
  announcements: Announcement[];
}
export function version(tag: string): number[] | null {
  const value = tag.replace(/^v/, "");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  const parts = value.split(".").map(Number);
  return parts.every((n) => n <= 4294967295) ? parts : null;
}
export function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
export function httpsLink(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
}
export function date(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
  );
}
export function validateAnnouncements(value: unknown): Announcement[] {
  if (
    !Array.isArray(value) ||
    value.length > 20 ||
    new TextEncoder().encode(JSON.stringify(value)).length > 65536
  )
    throw new Error("announcement budget exceeded");
  const ids = new Set<string>();
  for (const item of value) {
    if (
      !item ||
      typeof item.id !== "string" ||
      !item.id ||
      item.id.length > 100 ||
      ids.has(item.id) ||
      typeof item.title !== "string" ||
      !item.title ||
      item.title.length > 200 ||
      typeof item.body !== "string" ||
      item.body.length > 4000 ||
      !["info", "warning", "critical"].includes(item.severity) ||
      !date(item.publishedAt) ||
      !(
        item.expiresAt === null ||
        (date(item.expiresAt) && Date.parse(item.expiresAt) > Date.parse(item.publishedAt))
      ) ||
      !(item.link === null || httpsLink(item.link))
    )
      throw new Error("invalid announcement");
    ids.add(item.id);
  }
  return value;
}
export function buildManifest(
  releases: Release[],
  announcements: Announcement[],
  now = Date.now(),
): Manifest {
  const stable = releases.filter((r) => !r.draft && !r.prerelease && version(r.tag_name));
  stable.sort((a, b) => compare(version(b.tag_name)!, version(a.tag_name)!));
  const latest = stable[0];
  if (
    latest &&
    (!httpsLink(latest.html_url) ||
      !date(latest.published_at) ||
      !(latest.body === null || typeof latest.body === "string"))
  )
    throw new Error("invalid release");
  const notes = latest?.body ?? "";
  return {
    schemaVersion: 1,
    latestVersion: latest?.tag_name.replace(/^v/, "") ?? null,
    releaseUrl: latest?.html_url ?? null,
    releasedAt: latest?.published_at ?? null,
    releaseNotes:
      notes.length > 32000
        ? notes.slice(0, 32000) + "\n\n[发布说明已截断，请打开发布链接查看全文。]"
        : notes,
    announcements: announcements
      .filter(
        (a) =>
          Date.parse(a.publishedAt) <= now &&
          (a.expiresAt === null || Date.parse(a.expiresAt) > now),
      )
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)),
  };
}
