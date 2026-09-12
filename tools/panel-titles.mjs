/** 临时工具：列出所有 Panel 标题，按长度排序，用于判断是否写成了「句子」 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const root = "src/pages/MumaiDashboard";
const walk = (d) =>
  readdirSync(d).flatMap((name) => {
    const p = join(d, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const rows = [];
for (const f of walk(root).filter((x) => x.endsWith(".tsx"))) {
  const src = readFileSync(f, "utf8");
  const re = /<Panel[^>]*?title="([^"]+)"/g;
  let m;
  while ((m = re.exec(src))) rows.push([basename(f), m[1]]);
}

rows.sort((a, b) => b[1].length - a[1].length);
console.log(`Panel 标题共 ${rows.length} 个\n`);
for (const [f, t] of rows) {
  const flag = t.length >= 8 ? " ← 偏长" : "";
  console.log(`  ${f.padEnd(18)} ${t}${flag}`);
}
