import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { TranscriptStore } from "./transcript-store";
import type { Segment } from "./types";
const segment = (id: string, revision = 1) =>
  ({ id, transcription_id: "t", revision, text: id, ordinal: Number(id) }) as Segment;
const page = (ids: string[], current: string, previous: string | null, next: string | null) => ({
  items: ids.map((id) => segment(id)),
  current_cursor: current,
  previous_cursor: previous,
  next_cursor: next,
});
const response = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

// @use-case docs/feature/transcription/use-case/transcribe.md#正文搜索
describe("shared transcript HTTP reads", () => {
  it("shares in-flight first page, cursor aliases and cached anchor with search", async () => {
    let release!: (value: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const store = new TranscriptStore("t");
    const reading = store.page();
    const searching = store.all(new AbortController().signal);
    release(response(page(["0", "1"], "opaque-first", null, null)));
    expect((await reading).items).toHaveLength(2);
    expect(await searching).toHaveLength(2);
    await store.page("opaque-first");
    await store.page("", "1");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not mistake sparse pages for a complete transcript; follows opaque cursors", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(page(["90"], "far", "middle", null)))
      .mockResolvedValueOnce(response(page(["0"], "first", null, "middle")))
      .mockResolvedValueOnce(response(page(["50"], "middle", "first", "far")));
    vi.stubGlobal("fetch", fetch);
    const store = new TranscriptStore("t");
    await store.page("", "90");
    expect((await store.all(new AbortController().signal)).map((item) => item.id)).toEqual([
      "0",
      "50",
      "90",
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("a canceled search does not abort a shared reading request", async () => {
    let release!: (value: Response) => void;
    const fetch = vi.fn((_url, init) => {
      expect(init.signal.aborted).toBe(false);
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    vi.stubGlobal("fetch", fetch);
    const store = new TranscriptStore("t");
    const controller = new AbortController();
    const searching = store.all(controller.signal);
    const reading = store.page();
    controller.abort();
    release(response(page(["1"], "first", null, null)));
    await expect(searching).rejects.toMatchObject({ name: "AbortError" });
    expect((await reading).items[0].id).toBe("1");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("dispose rejects late responses and allows clean effect remount", async () => {
    let release!: (value: Response) => void;
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(response(page(["2"], "first", null, null)));
    vi.stubGlobal("fetch", fetch);
    const store = new TranscriptStore("t");
    const old = store.page();
    store.dispose();
    release(response(page(["1"], "first", null, null)));
    await expect(old).rejects.toMatchObject({ name: "AbortError" });
    expect((await store.page()).items[0].id).toBe("2");
  });
  it("keeps edits newer than in-flight results and retries failed pages", async () => {
    let release!: (value: Response) => void;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      );
    vi.stubGlobal("fetch", fetch);
    const store = new TranscriptStore("t");
    await expect(store.page()).rejects.toThrow();
    const reading = store.page();
    store.replace({ ...segment("1", 2), text: "corrected" });
    release(response(page(["1"], "first", null, null)));
    expect((await reading).items[0].text).toBe("corrected");
    expect((await store.all(new AbortController().signal))[0].text).toBe("corrected");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("isolates versions and rejects a response belonging to another version", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(page(["1"], "first", null, null)))
      .mockResolvedValueOnce(response(page(["1"], "first", null, null)));
    vi.stubGlobal("fetch", fetch);
    const original = new TranscriptStore("t");
    const other = new TranscriptStore("other");
    await original.page();
    await expect(other.page()).rejects.toThrow("不匹配");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await original.page()).items[0].transcription_id).toBe("t");
  });
  it("rejects a cyclic cursor instead of returning incomplete search results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response(page(["0"], "first", null, "first"))),
    );
    await expect(new TranscriptStore("t").all(new AbortController().signal)).rejects.toThrow(
      "重复分页游标",
    );
  });
});
