import { afterEach, describe, expect, it } from "vite-plus/test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import en from "@/locales/en.json";
import zh from "@/locales/zh-CN.json";
import i18n, { changeInterfaceLanguage, tr } from "./i18n";
import { date, stateName } from "./format";
import { errorMessage, HttpError } from "./api";
import { personName, segmentSpeakerName } from "./person-name";

afterEach(() => changeInterfaceLanguage("zh-CN"));
// @use-case docs/feature/interface-language/use-case/choose-language.md
describe("界面语言资源", () => {
  it("中英文键和插值参数一致，英文翻译完整", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    const parameters = (text: string) =>
      [...text.matchAll(/{{\s*(\w+)\s*}}/g)].map((match) => match[1]).sort();
    for (const [key, value] of Object.entries(en)) {
      expect(value.trim(), key).not.toBe("");
      expect(value, key).not.toMatch(/[\u3400-\u9fff]/);
      expect(parameters(value), key).toEqual(parameters(zh[key as keyof typeof zh]));
    }
  });
  it("静态翻译调用和源码中文均有资源定义", () => {
    const missing = new Set<string>();
    function scan(folder: string) {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const file = join(folder, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "locales") scan(file);
          continue;
        }
        if (!/\.tsx?$/.test(file) || /(?:\.test|\.generated)\./.test(file)) continue;
        const source = ts.createSourceFile(
          file,
          readFileSync(file, "utf8"),
          ts.ScriptTarget.Latest,
          true,
        );
        function visit(node: ts.Node) {
          if (
            ts.isCallExpression(node) &&
            node.expression.getText(source) === "tr" &&
            ts.isStringLiteral(node.arguments[0])
          ) {
            if (!Object.hasOwn(en, node.arguments[0].text))
              missing.add(`${entry.name}: ${node.arguments[0].text}`);
          }
          if (
            ts.isStringLiteral(node) &&
            /[\u3400-\u9fff]/.test(node.text) &&
            !Object.hasOwn(en, node.text)
          ) {
            missing.add(`${entry.name}: ${node.text}`);
          }
          if (
            ts.isJsxText(node) &&
            /[\u3400-\u9fff]/.test(node.text) &&
            node.text.trim() !== "简体中文"
          ) {
            missing.add(`${entry.name}: untranslated JSX ${node.text.trim()}`);
          }
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
    }
    scan(join(dirname(fileURLToPath(import.meta.url)), ".."));
    expect([...missing]).toEqual([]);
  });
  it("切换标签日期和错误文案，保留用户姓名", async () => {
    expect(stateName("running")).toBe("处理中");
    await i18n.changeLanguage("en");
    expect(stateName("running")).toBe("Processing");
    expect(tr("播放 {{v0}} 至本句结束", { v0: "00:03" })).toBe(
      "Play from 00:03 to the end of this sentence",
    );
    expect(date("2026-10-19T12:00:00Z")).toContain("Oct");
    expect(personName({ display_name: "音乐", builtin_key: null })).toBe("音乐");
    expect(personName({ display_name: "音乐", builtin_key: "music" })).toBe("Music");
    expect(
      segmentSpeakerName({ speaker_label_id: null, person_id: null, speaker_name: "未知说话人" }),
    ).toBe("Unknown speaker");
    expect(
      segmentSpeakerName({
        speaker_label_id: "custom-label",
        person_id: null,
        speaker_name: "未知说话人",
      }),
    ).toBe("未知说话人");
    expect(
      errorMessage(
        new HttpError(400, "invalid_ui_language", "界面语言仅支持简体中文和英文", "trace-1"),
      ),
    ).toBe("Interface language must be Simplified Chinese or English. (request trace-1)");
    expect(errorMessage(new HttpError(500, "future_error", "不能回显的未知内容", "trace-2"))).toBe(
      "The server rejected the request. (future_error) (request trace-2)",
    );
  });
});
