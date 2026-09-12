/** 临时工具：列出全平台「解释性长句」（className="note"）与较长的 hint/title，供文案清理决策 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const root = "src/pages/MumaiDashboard";
const walk = (d) =>
  readdirSync(d).flatMap((name) => {
    const p = join(d, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const files = walk(root).filter((f) => f.endsWith(".tsx"));

for (const f of files) {
  const src = readFileSync(f, "utf8");
  const hits = [];

  const noteRe = /<p className="note">([\s\S]*?)<\/p>/g;
  let m;
  while ((m = noteRe.exec(src))) {
    hits.push(["note", m[1].replace(/\{[^}]*\}/g, "{…}").replace(/\s+/g, " ").trim()]);
  }
  const hintRe = /hint="([^"]{25,})"/g;
  while ((m = hintRe.exec(src))) hits.push(["hint", m[1]]);
  const titleRe = /title="([^"]{0,})"/g;
  while ((m = titleRe.exec(src))) {
    if (m[1].length >= 22) hits.push(["title", m[1]]);
  }

  if (hits.length) {
    console.log(`\n=== ${basename(f)} ===`);
    for (const [kind, text] of hits) console.log(`  [${kind}] ${text}`);
  }
}
