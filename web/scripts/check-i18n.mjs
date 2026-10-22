import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const en = JSON.parse(readFileSync(join(root, "src/locales/en.json"), "utf8"));
const zh = JSON.parse(readFileSync(join(root, "src/locales/zh-CN.json"), "utf8"));
assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
const parameters = (text) => [...text.matchAll(/{{\s*(\w+)\s*}}/g)].map((match) => match[1]).sort();
for (const [key, value] of Object.entries(en)) {
  assert.notEqual(value.trim(), "", key);
  assert.doesNotMatch(value, /[\u3400-\u9fff]/, key);
  assert.deepEqual(parameters(value), parameters(zh[key]), key);
}

const missing = new Set();
function scan(folder) {
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
    function visit(node) {
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
scan(join(root, "src"));
assert.deepEqual([...missing], []);

console.log("翻译键、参数与源码完整性检查通过");
