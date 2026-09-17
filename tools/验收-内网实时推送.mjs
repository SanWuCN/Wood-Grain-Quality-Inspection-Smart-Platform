/**
 * 内网实时推送验收：**不刷新页面**，另一台机器建的工单/改的调度要自己出现在本机。
 *
 * ── 为什么不能只测 HTTP（本脚本存在的理由）──────────────────────────
 * `验收-多机协同.mjs` 全程用 fetch 打接口，证的是"服务端数据是共享的"；
 * 但用户看到的是**页面**：如果事件推不过去，另一台机器上就得手动刷新才出现新工单 ——
 * 现象与"没同步"一模一样。所以这里直接开一条 WebSocket（= 浏览器那条通道），
 * 在**不重新拉快照**的前提下等事件自己到。
 *
 * 检验四条：
 *   ① 连接后能收到 `hello`（带 lastSeq）；
 *   ② 另一台机器建单 → 本机这条通道收到 `workOrder.created`（同一个 orderId）；
 *   ③ 项目经理调度 → 收到 `workOrder.assigned`；
 *   ④ 断线重连（带 afterSeq）能把错过的事件补回来（局域网切网/休眠后靠它）。
 *
 * 用法：node tools/验收-内网实时推送.mjs [--base http://192.168.31.202:8000]
 */
const baseArg = process.argv.indexOf("--base");
const BASE = baseArg >= 0 ? process.argv[baseArg + 1] : "http://192.168.31.202:8000";
const WS_BASE = BASE.replace(/^http/, "ws");
const SESSION = "demo-01";
const PASSWORD = "123456";

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `　（${detail}）` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(account) {
  let token = "";
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    return { status: r.status, json, text };
  };
  return {
    call,
    async login() {
      const r = await call("POST", "/api/auth/login", { account, password: PASSWORD });
      token = r.json?.token ?? "";
      return r.status === 200 && Boolean(token);
    },
  };
}

/** 一条"像浏览器那样"的事件通道：连上后把收到的事件推进数组 */
function openChannel(afterSeq) {
  const events = [];
  let hello = null;
  let status = "connecting";
  const url = `${WS_BASE}/ws?sessionId=${encodeURIComponent(SESSION)}&afterSeq=${afterSeq}`;
  const ws = new WebSocket(url);
  ws.addEventListener("open", () => {
    status = "open";
  });
  ws.addEventListener("message", (e) => {
    let msg = null;
    try {
      msg = JSON.parse(typeof e.data === "string" ? e.data : "");
    } catch {
      return;
    }
    if (msg?.kind === "hello") hello = msg;
    if (msg?.kind === "event") events.push(msg);
  });
  ws.addEventListener("close", () => {
    status = "closed";
  });
  return { ws, events, get hello() { return hello; }, get status() { return status; }, url };
}

const waitFor = async (fn, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(100);
  }
  return false;
};

const A = client("shi"); // 本机（史）
const M = client("shen"); // 另一台机器（沈，项目经理）

console.log(`目标服务器：${BASE}\n`);

check("本机（史）登录", await A.login());
check("另一台机器（沈）登录", await M.login());

const snapshot = await A.call("GET", `/api/sessions/${encodeURIComponent(SESSION)}/snapshot`);
const lastSeq = snapshot.json?.session?.lastSeq ?? 0;
console.log(`  当前会话 lastSeq=${lastSeq}（HTTP ${snapshot.status}）`);
if (snapshot.status !== 200) {
  console.log(`  ⚠ 读不到快照，afterSeq 退化为 0（会重放历史事件）`);
}

/* ---------- ① 连接身份：hello 与 lastSeq ---------- */
const ch = openChannel(lastSeq);
check("WebSocket 能连上（同源 /ws 通道）", await waitFor(() => ch.status === "open", 5000), ch.status);
check("连上后收到 hello（带 lastSeq）", await waitFor(() => ch.hello !== null, 5000), JSON.stringify(ch.hello ?? {}));

/* ---------- ② 另一台机器建单 → 本机事件自己到 ---------- */
const eventId = `rt-${Date.now().toString(36)}`;
const created = await M.call("POST", "/api/work-orders/trigger", { eventId });
const newId = created.json?.orderId ?? "";
console.log(`\n  另一台机器建单：HTTP ${created.status}　${created.json?.orderNo ?? ""}（${newId}）`);
const gotCreated = await waitFor(
  () => ch.events.some((e) => e.type === "workOrder.created" && e.entityId === newId),
  6000,
);
check(
  "本机**不刷新**就收到了 workOrder.created",
  gotCreated,
  gotCreated ? `事件 ${ch.events.filter((e) => e.type === "workOrder.created").length} 条` : `只收到 ${ch.events.map((e) => e.type).join(" / ") || "（无）"}`,
);

/* ---------- ③ 调度 → assigned ---------- */
if (newId) {
  const assign = await M.call("PUT", `/api/work-orders/${newId}/assignment`, {
    leaderAccountId: "ma",
    members: [{ accountId: "rao", duties: [] }],
    note: "内网实时推送验收",
  });
  const gotAssigned = await waitFor(
    () => ch.events.some((e) => e.type === "workOrder.assigned" && e.entityId === newId),
    6000,
  );
  check(
    "本机**不刷新**就收到了 workOrder.assigned（人员调度同步）",
    gotAssigned,
    `HTTP ${assign.status}；事件 ${ch.events.filter((e) => e.type === "workOrder.assigned").length} 条`,
  );
}

/* ---------- ④ 断线重连：带 afterSeq 补缺口 ---------- */
ch.ws.close();
await sleep(300);
const seqBeforeReconnect = lastSeq;
const ch2 = openChannel(seqBeforeReconnect);
check("重连成功", await waitFor(() => ch2.status === "open", 5000), ch2.status);
const replayed = await waitFor(
  () => ch2.events.some((e) => e.entityId === newId) || (ch2.hello?.replayed ?? 0) > 0,
  6000,
);
check(
  "重连后把断线期间的事件补了回来（afterSeq 缺口补齐）",
  Boolean(replayed),
  `hello.replayed=${ch2.hello?.replayed ?? "?"}`,
);
ch2.ws.close();

/* ---------- ⑤ 内网协同接口：端数 + 同事该念的地址 ---------- */
const peers = await A.call("GET", `/api/sessions/${SESSION}/peers`);
const pj = peers.json ?? {};
check("内网协同接口可读（/api/sessions/:id/peers）", peers.status === 200, `HTTP ${peers.status}`);
check(
  "端数是真实连接数（本脚本开着一条通道，所以 ≥1）",
  Number(pj.peers ?? 0) >= 1,
  `peers=${pj.peers}　clients=${pj.clients}`,
);
const urls = Array.isArray(pj.lanUrls) ? pj.lanUrls : [];
check(
  "给出了同事可直接打开的内网地址（且都是私有网段）",
  urls.length > 0 &&
    urls.every((u) => /^http:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u)),
  urls.length ? urls.join(" / ") : "（没读到内网地址）",
);
check("地址用的端口 = 服务实际端口（不写死 8000）", urls.every((u) => u.endsWith(`:${pj.port}`)), `port=${pj.port}`);

/* ---------- 清理 ---------- */
if (newId) {
  const del = await A.call("DELETE", `/api/work-orders/${newId}`);
  console.log(`\n  清理临时工单：HTTP ${del.status}`);
  check("临时工单已删除", del.status >= 200 && del.status < 300, `HTTP ${del.status}`);
}

console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项未通过`}（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
