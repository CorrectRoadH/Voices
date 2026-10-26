import { describe, expect, it } from "vite-plus/test";
import {
  emptyWindow,
  windowReducer,
  type WindowState,
  type WindowPage,
} from "./transcript-window-state";
import type { Segment, TranscriptionDetail } from "./types";
const version = { id: "t", recording_id: "r", state: "succeeded" } as TranscriptionDetail;
const segment = (id: string, revision = 1) =>
  ({
    id,
    ordinal: Number(id),
    revision,
    text: `text-${id}`,
    recording_id: "r",
    transcription_id: "t",
  }) as Segment;
const page = (id: string): WindowPage => ({
  items: [segment(id)],
  current_cursor: id,
  previous_cursor: id === "0" ? null : "previous",
  next_cursor: "next",
});
const sync = (state: WindowState, anchor: string | null, reload = 0, key = "r/t/visible") =>
  windowReducer(state, {
    type: "sync",
    key,
    anchor,
    reload,
    selected: true,
    status: "succeeded",
    showBuiltin: false,
  });
function loaded(state: WindowState, id: string) {
  return windowReducer(state, { type: "loaded", load: state.pending!, version, page: page(id) });
}
const initial = () => loaded(sync(emptyWindow, null), "0");

// @use-case docs/feature/transcription/use-case/transcribe.md
describe("正文窗口导航和缓存边界", () => {
  it("已加载定位不创建请求；未加载定位保留当前正文，取消后不接受旧结果", () => {
    const current = initial();
    const local = sync(current, "0");
    expect(local.pending).toBeNull();
    expect(local.segments).toBe(current.segments);
    const far = sync(local, "100");
    expect(far.segments).toBe(local.segments);
    expect(far.pending?.version).toBe(version);
    const cancelled = sync(far, "0");
    expect(
      windowReducer(cancelled, { type: "loaded", load: far.pending!, version, page: page("100") }),
    ).toBe(cancelled);
  });
  it("加载失败保留正文和旧锚点，可改选其它位置", () => {
    const pending = sync(initial(), "100");
    const failed = windowReducer(pending, {
      type: "failed",
      load: pending.pending!,
      error: "offline",
    });
    expect(failed.segments?.items[0].id).toBe("0");
    expect(failed.anchor).toBeNull();
    expect(sync(failed, "0").error).toBe("");
  });
  it("回到缓存窗口无需请求，改字同步缓存并覆盖较旧的在途结果", () => {
    const far = loaded(sync(initial(), "100"), "100");
    const edited = { ...segment("0", 2), text: "edited" };
    const saved = windowReducer(far, { type: "replace", segment: edited });
    const back = sync(saved, "0");
    expect(back.pending).toBeNull();
    expect(back.segments?.items[0].text).toBe("edited");
    const refresh = sync(back, "0", 1);
    const fresh = loaded(refresh, "0");
    expect(fresh.segments?.items[0].revision).toBe(2);
  });
  it("离开包含内置人物的引用窗口后恢复普通阅读过滤", () => {
    const anchored = loaded(sync(emptyWindow, "0"), "0");
    expect(anchored.hideBuiltin).toBe(false);
    const plain = sync(anchored, null);
    expect(plain.pending?.hideBuiltin).toBe(true);
    expect(plain.pending?.cursor).toBe("");
  });
  it("窗口缓存有界，刷新及切换版本隔离旧数据", () => {
    let state = initial();
    for (let i = 1; i < 12; i++) state = loaded(sync(state, String(i)), String(i));
    expect(state.cache.length).toBeLessThanOrEqual(4);
    const refresh = sync(state, "11", 1);
    expect(refresh.cache).toEqual([]);
    expect(refresh.pending?.version).toBeNull();
    expect(refresh.segments).toBe(state.segments);
    const other = sync(state, "11", 0, "r/other/visible");
    expect(other.segments).toBeNull();
    expect(other.cache).toEqual([]);
    expect(other.edits.size).toBe(0);
  });
});
