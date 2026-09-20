/**
 * 端到端核对：工单走完整条链 → 归档 → 自动登进知识库 → **当场搜得到**
 *
 * 默认**自带清场**（跑完删掉这次建的工单与它登进知识库的那条资产），
 * 这样它可以反复跑而不往演示库里堆垃圾；要留证据就加 `--keep`。
 *
 * 用法：node _e2e-工单归档进知识库.mjs [--base http://127.0.0.1:8000] [--keep]
 */
const baseArg = process.argv.indexOf("--base");
const BASE = (baseArg >= 0 ? process.argv[baseArg + 1] : "http://127.0.0.1:8000").replace(/\/$/, "");
const KEEP = process.argv.includes("--keep");

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `　（${detail}）` : ""}`);
  if (!ok) failed += 1;
};
const info = (text) => console.log(`    · ${text}`);

const client = async (account) => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account, password: "123456" }),
  });
  const token = (await r.json())?.token ?? "";
  const call = async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, json, text };
  };
  return { call };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const shi = await client("shi");
const shen = await client("shen");
let orderId = "";
let assetId = "";

try {
  /* 1. 建单 → 指派 → 环境读数 → 校验（走真实接口，归档记录里才有真数字） */
  const created = await shi.call("POST", "/api/work-orders/trigger", { eventId: `kbe2e-${Date.now().toString(36)}` });
  orderId = created.json?.orderId ?? "";
  const orderNo = created.json?.orderNo ?? "";
  check("建单", created.status === 200 && Boolean(orderId), orderNo);

  const assigned = await shen.call("PUT", `/api/work-orders/${orderId}/assignment`, {
    leaderAccountId: "shi",
    members: [{ accountId: "rao", duties: ["environment_entry"] }],
  });
  check("沈指派负责人 → 史（校验与归档的前置）", assigned.status === 200, `HTTP ${assigned.status}`);

  const draft = await shi.call("PUT", `/api/work-orders/${orderId}/environment-draft`, {
    expectedRevision: null,
    inputs: { airTempC: 22, relativeHumidityPct: 58, windSpeedMs: 0.6, atmosphericPressureHpa: null },
    pressure: { value: 101, unit: "kPa" },
    instruments: [],
    position: "示例寺院内四根木柱检测区域",
    measuredAt: new Date(Date.now() - 60000).toISOString().slice(0, 16),
  });
  check("保存环境草稿", draft.status === 200, `rev=${draft.json?.environment?.draftRevision}`);

  const validated = await shi.call("POST", `/api/work-orders/${orderId}/environment/validate`, {
    expectedRevision: draft.json?.environment?.draftRevision ?? null,
  });
  check("运行校验", validated.status === 200, validated.json?.environment?.config?.configVersion ?? `HTTP ${validated.status}`);

  /* 2. 归档 —— 这一下应当自动登进知识库 */
  const archived = await shi.call("POST", `/api/work-orders/${orderId}/status`, { action: "archive" });
  const knowledge = archived.json?.knowledge ?? null;
  assetId = knowledge?.assetId ?? "";
  check("归档成功", archived.status === 200 && archived.json?.order?.status === "已归档", `状态=${archived.json?.order?.status}`);
  check(
    "归档时自动登记知识库资产并建索引任务",
    Boolean(assetId && knowledge?.jobId),
    `资产 ${assetId || "无"}　任务 ${knowledge?.jobId || "无"}${knowledge?.error ? `　错误：${knowledge.error}` : ""}`,
  );

  /* 3. 等索引任务发布（终态词是「成功」，不是「已完成」） */
  let job = null;
  for (let i = 0; i < 60; i += 1) {
    job = (await shi.call("GET", `/api/knowledge/jobs/${knowledge.jobId}`)).json?.job ?? null;
    if (job && !["运行", "排队"].includes(job.status)) break;
    await sleep(500);
  }
  check("索引任务发布新版本", job?.status === "成功", `${job?.status ?? "?"}　版本 ${job?.targetVersion ?? "?"}`);

  /* 4. 当场检索：这一单必须能被搜到 */
  const find = async (query) =>
    ((await shi.call("POST", "/api/knowledge/search", { query, topK: 8 })).json?.hits ?? []).find((hit) => hit.assetId === assetId);

  for (const query of [orderNo, "示例寺 四根木柱", "上海市松江区示例寺院内", "环境读数 大气压 校验"]) {
    const hit = await find(query);
    check(
      `检索「${query}」命中刚归档的这一单`,
      Boolean(hit),
      hit ? `相似度 ${hit.score}　「${String(hit.snippet).replace(/\s+/g, " ").slice(0, 40)}…」` : "没命中",
    );
  }
  /* 「Z04 下部测区」这类**测区/热点**词不在工单实体里（本单主体位置仍是「待定位」），
     命中不到是口径正确的表现 —— 这里只作说明，不算失败。 */
  info("（测区/热点类词如「Z04 下部测区」不在工单实体内，检索不到属正常；工单里只有 Z01–Z04 编号）");

  /* 5. 资产详情 */
  const detail = await shi.call("GET", `/api/knowledge/assets/${assetId}`);
  const asset = detail.json?.asset ?? detail.json ?? {};
  check("资产可打开、分类与来源正确", asset.id === assetId, `${asset.title ?? ""}　${asset.mainSource ?? ""}（${asset.sourceSystem ?? ""}）`);
  check(
    "对象编号挂了单号与四根主体",
    ["WO-", "Z01", "Z02", "Z03", "Z04"].every((needle) => (asset.objectIds ?? []).some((id) => String(id).includes(needle))),
    (asset.objectIds ?? []).join("、"),
  );
} finally {
  if (!KEEP && orderId) {
    const del = await shi.call("DELETE", `/api/work-orders/${orderId}`);
    console.log(`\n  清场：删除本单 HTTP ${del.status}`);
  }
  if (!KEEP && assetId) {
    const del = await shi.call("POST", "/api/commands", {
      action: "asset.delete",
      entityId: assetId,
      commandId: `del-${assetId}-${Date.now().toString(36)}`,
      sessionId: "demo-01",
    });
    console.log(`  清场：删除知识库资产 ${assetId} HTTP ${del.status}${del.status === 200 ? "" : `　${String(del.text).slice(0, 120)}`}`);
  }
  if (KEEP) console.log(`\n  保留：工单 ${orderId}　资产 ${assetId}`);
}

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项未通过`}`);
process.exit(failed === 0 ? 0 : 1);
