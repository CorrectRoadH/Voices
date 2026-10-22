import { describe, expect, it } from "vite-plus/test";
import { basePath, safeReturnPath, sentenceMarkdown, sentenceUrl, validateAnchor } from "./links";
import type { Segment, TranscriptionDetail } from "./types";
const segment = {
  id: "s-1",
  recording_id: "r-1",
  transcription_id: "old-version",
  text: "校正 [文字]\\正文\n下一行",
  source_text: "原始文字",
  speaker_name: "张[三]",
  start_ms: null,
} as Segment;
const version = { id: "old-version", recording_id: "r-1" } as TranscriptionDetail;
// @use-case docs/feature/sentence-links/use-case/copy-sentence-link.md
describe("稳定句子引用", () => {
  it("使用当前人物、校正文、历史版本和配置前缀生成绝对引用", () => {
    expect(
      sentenceMarkdown("https://voices.example/private/", segment, "https://untrusted.example"),
    ).toBe(
      "[张\\[三\\]: 校正 \\[文字\\]\\\\正文 下一行](https://voices.example/private/recordings/r-1/transcriptions/old-version?segment=s-1)",
    );
    expect(
      sentenceUrl("/voices/", { ...segment, text: "不进入 URL" }, "https://voices.example"),
    ).toBe("https://voices.example/voices/recordings/r-1/transcriptions/old-version?segment=s-1");
  });
  it("明确拒绝归属不匹配，不回退激活版本", () => {
    expect(() => validateAnchor("r-1", "old-version", version, segment)).not.toThrow();
    expect(() => validateAnchor("r-2", "old-version", version, segment)).toThrow("不匹配");
    expect(() => validateAnchor("r-1", "new-version", version, segment)).toThrow("不匹配");
    expect(() =>
      validateAnchor("r-1", "old-version", version, { ...segment, transcription_id: "other" }),
    ).toThrow("不匹配");
  });
});
// @feature docs/feature/sentence-links/README.md
describe("鉴权返回地址", () => {
  it("保留本站前缀下的完整深链接", () => {
    const path = "/voices/recordings/r/transcriptions/t?segment=s#fragment";
    expect(safeReturnPath(path, "/voices")).toBe(path);
    expect(basePath("https://voices.example/voices/")).toBe("/voices");
  });
  it.each([
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/outside",
    "/voices-evil/path",
    "/voices/\nmalicious",
  ])("拒绝不安全或前缀外的地址 %s", (path) => {
    expect(safeReturnPath(path, "/voices")).toBe("/voices/recordings");
  });
});
