import { describe, expect, it } from "vite-plus/test";
import { optionError } from "./options";
import type { Options, Provider } from "@/lib/types";
const providers: Provider[] = [
  {
    id: "soniox",
    name: "Soniox",
    configured: true,
    models: [
      {
        id: "model",
        name: "Model",
        languages: ["zh", "en"],
        language_modes: ["single", "multi"],
        diarization: true,
        timestamps: false,
        max_duration_ms: 1000,
        max_file_bytes: 100,
      },
    ],
  },
];
const options: Options = {
  provider: "soniox",
  model: "model",
  language_mode: "single",
  languages: ["zh"],
  diarization: true,
};
// @use-case docs/feature/transcription/use-case/transcribe.md
describe("提交前的模型能力验证", () => {
  it("接受支持的选择，但不静默调整不支持的选择", () => {
    expect(optionError(options, providers)).toBe("");
    expect(optionError({ ...options, language_mode: "auto", languages: [] }, providers)).toContain(
      "语言模式",
    );
    expect(optionError({ ...options, languages: ["ja"] }, providers)).toContain("支持范围");
    expect(
      optionError(options, [
        { ...providers[0], models: [{ ...providers[0].models[0], diarization: false }] },
      ]),
    ).toContain("说话人");
    expect(options.languages).toEqual(["zh"]);
  });
  it("拒绝文件与时长超限，以及不完整的多语言模式", () => {
    expect(optionError(options, providers, { duration_ms: 1001 })).toContain("时长");
    expect(optionError(options, providers, { size_bytes: 101 })).toContain("大小");
    expect(optionError({ ...options, language_mode: "multi" }, providers)).toContain("至少两种");
  });
});

// @use-case docs/feature/transcription/use-case/transcribe.md
it("Universal-2 的多语言限制明确解释且不改变用户选择", () => {
  const assembly = [
    {
      ...providers[0],
      id: "assemblyai",
      models: [{ ...providers[0].models[0], id: "universal-2", languages: ["en", "zh", "ja"] }],
    },
  ];
  const value: Options = {
    ...options,
    provider: "assemblyai",
    model: "universal-2",
    language_mode: "multi",
    languages: ["zh", "ja"],
  };
  expect(optionError(value, assembly)).toContain("en 加一种其他语言");
  expect(value.languages).toEqual(["zh", "ja"]);
  expect(optionError({ ...value, languages: ["en", "zh"] }, assembly)).toBe("");
  expect(optionError({ ...value, languages: ["en", "zh", "ja"] }, assembly)).toContain(
    "en 加一种其他语言",
  );
});
