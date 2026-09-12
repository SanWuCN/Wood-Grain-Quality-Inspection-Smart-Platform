/** 把 docx 的 word/document.xml 提取成纯文本（临时工具） */
import { readFileSync, writeFileSync } from "node:fs";

const xml = readFileSync(process.argv[2], "utf8");
const paras = xml
  .split(/<\/w:p>/)
  .map((p) => {
    const list = /<w:numPr>/.test(p);
    const bold = /<w:b\/>|<w:b /.test(p);
    const raw = (p.match(/<w:t[^>]*>[\s\S]*?<\/w:t>/g) || [])
      .map((s) => s.replace(/<[^>]+>/g, ""))
      .join("");
    const t = raw
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"');
    // 表格行：w:tc 之间插竖线
    return { t, list, bold };
  })
  .filter((p) => p.t.trim());

const out = paras
  .map((p) => (p.bold && p.t.length < 40 ? `## ${p.t}` : `${p.list ? "- " : ""}${p.t}`))
  .join("\n");
writeFileSync(process.argv[3], out, "utf8");
console.log(`chars=${out.length} paras=${paras.length}`);
