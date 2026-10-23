import { describe, expect, it } from "vite-plus/test";
import {
  basePath,
  safeReturnPath,
  sentenceMarkdown,
  sentenceUrl,
  validateAnchor,
  referenceMarkdown,
  referenceUrl,
  escapeMarkdown,
} from "./links";
import type { Segment, TranscriptionDetail, Schema } from "./types";
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
// @use-case docs/feature/sentence-links/use-case/copy-sentence-link.md#copy-selection
describe("Obsidian 短引用", () => {
  const reference: Schema["TranscriptReference"] = {
    code: "Ab3kP9x2Lm7Q",
    recording_id: "r-1",
    transcription_id: "old-version",
    segments: [
      { ...segment, speaker_label_id: "speaker-1", ordinal: 0 },
      { ...segment, id: "s-2", speaker_label_id: "speaker-1", text: "连续发言", ordinal: 1 },
      { ...segment, id: "s-5", speaker_label_id: "speaker-1", text: "另一段", ordinal: 4 },
    ],
  };
  it("每段可点击，使用同一短码与组内位置，只在跳过原文时标明省略", () => {
    const markdown = referenceMarkdown(
      "https://voices.example/private/",
      reference,
      "https://untrusted.example",
    );
    expect(markdown).toBe(
      "[张\\[三\\]: 校正 \\[文字\\]\\\\正文 下一行](https://voices.example/private/q/Ab3kP9x2Lm7Q)\n\n" +
        "[张\\[三\\]: 连续发言](https://voices.example/private/q/Ab3kP9x2Lm7Q?at=2)\n\n" +
        "〔中间有省略〕\n\n[张\\[三\\]: 另一段](https://voices.example/private/q/Ab3kP9x2Lm7Q?at=3)",
    );
    expect(markdown).not.toContain("来源");
    expect(markdown).not.toContain("transcriptions/");
  });
  it("转义 Markdown 排版、HTML 与实体，编码 URL 括号并保留配置前缀", () => {
    expect(escapeMarkdown("*粗体* `代码` _斜体_ ~~划线~~ <b>&amp;</b> ![图](url)")).toBe(
      "\\*粗体\\* \\`代码\\` \\_斜体\\_ \\~\\~划线\\~\\~ &lt;b&gt;&amp;amp;&lt;/b&gt; !\\[图\\](url)",
    );
    expect(referenceUrl("/voices(a)/?old=1#old", reference.code, "https://voices.example", 1)).toBe(
      "https://voices.example/voices%28a%29/q/Ab3kP9x2Lm7Q?at=2",
    );
    expect(safeReturnPath("/voices/q/Ab3kP9x2Lm7Q?at=3", "/voices")).toBe(
      "/voices/q/Ab3kP9x2Lm7Q?at=3",
    );
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
