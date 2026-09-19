/**
 * 探针：哪几种问法能在知识库里**真的命中**（给第①轮挑一句屏幕上的检索问题）
 * 用法：node --import ./tools/test-resolve-ts.mjs tools/探-知识库命中.mjs
 */
const BASE = "http://127.0.0.1:8000";
const questions = [
  "巡检工单与风险点处置",
  "巡检工单里的风险点处置记录",
  "按风险点查看巡检工单处置",
  "巡检工单 风险点 处置",
  "风险点处置记录",
  "工单 风险点",
];

const login = await (await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ account: "shi", password: "123456" }),
})).json();
const token = login.token;

for (const query of questions) {
  const res = await (await fetch(`${BASE}/api/knowledge/search`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, topK: 10 }),
  })).json();
  const hits = res.hits ?? [];
  const titles = hits.slice(0, 3).map((hit) => `${hit.docTitle || hit.title || hit.docId || "?"}·${hit.chunkId}（${Number(hit.score).toFixed(2)}）`);
  console.log(`${hits.length.toString().padStart(2)} 命中 · ${query}`);
  if (titles.length) console.log(`      ${titles.join(" / ")}`);
}
