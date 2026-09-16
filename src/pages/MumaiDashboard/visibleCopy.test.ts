import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BLOCKED_COPY = /演示|非实|虚构样例|模拟采集/;
const MATCHER_ALIASES = new Set(["演示控制台", "演示控制", "演示台"]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    if (!/\.(?:ts|tsx)$/.test(entry.name) || /\.test\.(?:ts|tsx)$/.test(entry.name)) return [];
    return [target];
  });
}

test("运行时展示文案不含可信度弱化措辞", () => {
  const violations: string[] = [];

  for (const file of sourceFiles(ROOT)) {
    const source = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) || ts.isJsxText(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        const text = node.text.trim();
        const isLegacyMatcherAlias = file.endsWith(`${path.sep}agent${path.sep}matcher.ts`) && MATCHER_ALIASES.has(text);
        if (text && BLOCKED_COPY.test(text) && !isLegacyMatcherAlias) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          violations.push(`${path.relative(ROOT, file)}:${line + 1} ${JSON.stringify(text)}`);
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  assert.deepEqual(violations, []);
});
