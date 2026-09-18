/**
 * 内网同步验收 · **两台真浏览器**（用户口径 2026-09-18）
 *
 * 用户原话：「我这边添加工单，沈那边收不到；沈那边派发人员，我这边也同步不到」，
 * 紧接着问：「能做到我队友在登录 http://192.168.31.202:8000/ 中的交互，互相同步吗」。
 *
 * ── 这一组在证什么 ──────────────────────────────────────────────────
 * 两台**互相独立**的真浏览器（各自一份 profile：各自的令牌、各自的 WebSocket）：
 *   · A 台 = 本机 `http://127.0.0.1:8000`，登录 shi（现场操作平台的人）；
 *   · B 台 = **服务端自己报出来的局域网地址**（默认念第一条），登录 shen（项目经理）——
 *     这就是"队友在 192.168.31.202:8000 登录"那台。
 * 然后互相看对方的动作**不刷新**会不会自己出现，并且把"谁连到了这台服务器"
 * 与"这条写入几台端收到了"读成可证伪的数字。地址一律取服务端读数，
 * 不从 ipconfig 里抄、不写死 IP。
 *
 * ── 与另外两个验收的分工 ────────────────────────────────────────────
 *   `验收-多机协同.mjs`    ：三台"机器"（fetch 客户端）打同一台服务器 —— 证服务端数据共享；
 *   `验收-内网实时推送.mjs`：一条裸 WebSocket —— 证事件推得出去、断线补得回来；
 *   **本脚本**            ：两台真浏览器（两台"电脑"）—— 证现场那一幕：
 *                          「他建的单我这边自己出现；我派的人他那边自己出现」。
 *
 * 判据（都能证伪）：
 *   ① A 台登录后顶栏「平台」正常（浏览器到共享服务的实时通道通了）；
 *   ② B 台用**服务端自己报的局域网地址**打开并登录成功；
 *   ③ A 台建单 → B 台**不刷新**就出现该单号；
 *   ④ B 台派发人员 → A 台**不刷新**就同步（负责人不再是「未指派负责人」）；
 *   ⑤ B 台删单 → A 台那一行自己消失；
 *   ⑥ 顶栏「协同」：A 台（本机地址）显示「本机 · N 台」，B 台（局域网地址）显示「N 台」；
 *   ⑦ 排练控制台「内网协同」：端明细里两台都在（各自的对端地址），
 *      服务器身份与可达地址（局域网 + 虚拟局域网）都念得出来；
 *   ⑧ 「开一次实测」：结论是「写入→全网可见 M/N 台」这种可证伪的话，且至少两台回了执；
 *   ⑨ 「最近写入来源」里同时有来自本机与来自局域网那台的写入 —— 这就是
 *      "他到底写没写进来"的答案。
 *
 * 前置：8000 在跑（`node server/index.mjs --static dist`）。
 * 用法：node tools/验收-内网同步-浏览器.mjs [--base http://127.0.0.1:8000]
 *      （B 台地址默认取服务端自报的推荐地址，可用 --peer-base http://… 覆盖）
 */
import { Machine, SHOT_DIR, sleep } from "./browser-harness.mjs";

const argOf = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
/** A 台（本机）地址：现场操作平台的人 */
const SELF_BASE = (argOf("--base", "http://127.0.0.1:8000") ?? "").replace(/\/$/, "");
/** B 台（队友）地址：默认留空，稍后取服务端自报的推荐地址 */
const PEER_BASE_ARG = (argOf("--peer-base", "") ?? "").replace(/\/$/, "");
const PASSWORD = "123456";

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `　（${detail}）` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
};

/** 本页上的工单列表读数（单号 + 负责人），列表在工单页左侧那一列 */
const ORDERS_PROBE = `(() => {
  const rows = [...document.querySelectorAll('.orders-side .orders-history .order-item')];
  return {
    hash: location.hash,
    count: rows.length,
    numbers: rows.map((r) => (r.querySelector('b')?.textContent || '').trim()),
    leaders: rows.map((r) => (r.querySelector('.wop-row__status em')?.textContent || '').trim()),
  };
})()`;

/** 顶栏状态条：某一格的文字（按标签取，不按位置取） */
const chipProbe = (label) => `(() => {
  const strip = document.querySelector('.appshell__channels');
  if (!strip) return null;
  for (const btn of strip.querySelectorAll('button')) {
    const name = (btn.querySelector('.appshell__channels-label')?.textContent || '').trim();
    if (name === ${JSON.stringify(label)}) return (btn.textContent || '').replace(name, '').trim();
  }
  return null;
})()`;

/** 服务端自己报的推荐地址：同事该打开的那一条（现场就是这么念的） */
async function recommendedBase() {
  const login = await fetch(`${SELF_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: "shi", password: PASSWORD }),
  });
  const auth = await login.json();
  const response = await fetch(`${SELF_BASE}/api/sessions/demo-01/peers`, {
    headers: { authorization: `Bearer ${auth.token}` },
  });
  const peers = await response.json();
  const hit = peers.addresses?.find((item) => item.recommended) ?? peers.addresses?.[0] ?? null;
  return { base: hit?.url ?? null, peers, auth, kind: hit?.kind ?? null, iface: hit?.iface ?? null };
}

const A = new Machine({ name: "self", port: 9511, base: SELF_BASE, account: "shi" });
let B = null;
let createdId = "";
let createdNo = "";

try {
  const recommended = await recommendedBase();
  const PEER_BASE = PEER_BASE_ARG || recommended.base;
  if (!PEER_BASE) throw new Error("服务端没报出对内地址，队友那台打不开这一台（先在设置里确认网络）");
  console.log(`A 台（本机）：${SELF_BASE}　登录 shi`);
  console.log(
    `B 台（队友）：${PEER_BASE}　登录 shen　← 服务端自报的${recommended.kind === "vpn" ? "虚拟局域网" : "局域网"}地址` +
      `${recommended.iface ? `（${recommended.iface}）` : ""}\n`,
  );
  B = new Machine({ name: "peer", port: 9512, base: PEER_BASE, account: "shen" });

  await Promise.all([A.start(), B.start()]);
  const [aIn, bIn] = await Promise.all([A.login(), B.login()]);
  check("A 台（本机 127.0.0.1）登录成功并进入平台", aIn, `hash=${await A.evaluate(`location.hash`)}`);
  check(
    "B 台（队友那台，用服务端自报的局域网地址打开）登录成功",
    bIn,
    `${PEER_BASE} · hash=${await B.evaluate(`location.hash`)}`,
  );

  /* ---------- ① 两台各自的实时通道 ---------- */
  await A.evaluate(`location.hash = '#/orders'`);
  await sleep(1200);
  let aOrders = await A.evaluate(ORDERS_PROBE);
  for (let i = 0; i < 40 && aOrders.count === 0; i += 1) {
    await sleep(250);
    aOrders = await A.evaluate(ORDERS_PROBE);
  }
  check("A 台工单列表已渲染（不是空页）", aOrders.count > 0, `${aOrders.count} 条`);
  const aPlatform = await A.evaluate(chipProbe("平台"));
  check("A 台顶栏「平台」显示实时通道正常（WebSocket 已连上）", String(aPlatform).includes("正常"), `读到「${aPlatform}」`);

  /* ---------- ② 顶栏「协同」：本机模式 vs 队友那台 ---------- */
  const aCollab = await A.evaluate(chipProbe("协同"));
  const bCollab = await B.evaluate(chipProbe("协同"));
  check(
    "A 台顶栏「协同」认出这是本机地址（现场最容易犯的错，先自己说出来）",
    /本机 · \d+ 台/.test(String(aCollab)),
    `读到「${aCollab}」`,
  );
  check(
    "B 台顶栏「协同」读的是局域网地址（不是本机模式），并报出端数",
    /^\d+ 台$/.test(String(bCollab).trim()),
    `读到「${bCollab}」`,
  );

  /* ---------- ③ A 台建单 → B 台不刷新就出现 ---------- */
  const eventId = `lan2-${Date.now().toString(36)}`;
  const created = await A.call("POST", "/api/work-orders/trigger", { eventId });
  createdId = created.json?.orderId ?? "";
  createdNo = created.json?.orderNo ?? "";
  console.log(`\n  A 台建单：HTTP ${created.status}　${createdNo}（${createdId}）`);

  await B.evaluate(`location.hash = '#/orders'`);
  await sleep(1200);
  let bOrders = await B.evaluate(ORDERS_PROBE);
  for (let i = 0; i < 40 && bOrders.count === 0; i += 1) {
    await sleep(250);
    bOrders = await B.evaluate(ORDERS_PROBE);
  }
  let appeared = false;
  for (let i = 0; i < 60; i += 1) {
    bOrders = await B.evaluate(ORDERS_PROBE);
    if (bOrders.numbers.includes(createdNo)) {
      appeared = true;
      break;
    }
    await sleep(250);
  }
  check(
    "A 台建的单，B 台**不刷新**就出现了（workOrder.created 事件驱动）",
    appeared,
    appeared ? `${bOrders.count} 条里含 ${createdNo}` : `B 台列表里没有 ${createdNo}：${bOrders.numbers.join(" / ")}`,
  );
  check("B 台全程没有重新加载页面", String(await B.evaluate(`location.hash`)) === "#/orders");

  /* ---------- ④ B 台派发人员 → A 台不刷新就同步 ---------- */
  if (createdId) {
    const detail = await B.call("GET", `/api/work-orders/${createdId}`);
    /* 指派走的是 `assignment_revision` 这一路（与工单自身的 revision 是两条并发线） */
    const assignmentRevision = detail.json?.order?.assignmentRevision ?? 0;
    const assign = await B.call("PUT", `/api/work-orders/${createdId}/assignment`, {
      leaderAccountId: "ma",
      members: [{ accountId: "rao", duties: [] }],
      expectedRevision: assignmentRevision,
    });
    console.log(`  B 台派发人员：HTTP ${assign.status}`);
    let leader = "";
    for (let i = 0; i < 60; i += 1) {
      const now = await A.evaluate(ORDERS_PROBE);
      const idx = now.numbers.indexOf(createdNo);
      leader = idx >= 0 ? now.leaders[idx] : "";
      if (leader && leader !== "未指派负责人") break;
      await sleep(250);
    }
    check(
      "B 台派发的人员，A 台**不刷新**就同步了（负责人不再是「未指派负责人」）",
      Boolean(leader) && leader !== "未指派负责人",
      `HTTP ${assign.status}；A 台读到负责人=「${leader}」`,
    );
  }

  /* ---------- ⑤ 协同面板：两台都在列表里，地址/服务器/实测/写入来源都念得出来 ---------- */
  await A.evaluate(`location.hash = '#/console'`);
  await sleep(1500);
  const PANEL_PROBE = `(() => {
    const panel = document.querySelector('.cs-lan-panel');
    if (!panel) return { found: false };
    const rows = [...panel.querySelectorAll('.cs-lan > li')].map((li) => ({
      key: (li.querySelector('b')?.textContent || '').trim(),
      text: (li.querySelector('span')?.textContent || '').replace(/\\s+/g, ' ').trim(),
    }));
    return {
      found: true,
      rows,
      urls: [...panel.querySelectorAll('.cs-lan__url')].map((el) => (el.textContent || '').trim()),
      vpnUrls: [...panel.querySelectorAll('.cs-lan__url--vpn')].map((el) => (el.textContent || '').trim()),
      ends: [...panel.querySelectorAll('.cs-lan__ends li')].map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim()),
      writes: [...panel.querySelectorAll('.cs-lan__table tbody tr')].map((tr) =>
        [...tr.querySelectorAll('td')].map((td) => (td.textContent || '').trim()),
      ),
      text: (panel.textContent || '').replace(/\\s+/g, ' ').trim(),
    };
  })()`;
  let panel = await A.evaluate(PANEL_PROBE);
  for (let i = 0; i < 40 && !panel?.found; i += 1) {
    await sleep(250);
    panel = await A.evaluate(PANEL_PROBE);
  }
  check("排练控制台有「内网协同」面板", Boolean(panel?.found));
  const rowText = (key) => panel?.rows?.find((row) => row.key === key)?.text ?? "";
  check(
    "面板报出这台服务器的身份（主机名 · 端口 · 库文件 · 启动时刻）",
    /数据 .*mumai\.db/.test(rowText("服务器")) && /:8000/.test(rowText("服务器")),
    rowText("服务器"),
  );
  const lanUrls = (panel?.urls ?? []).filter((url) => /^http:\/\/[\d.]+:\d+$/.test(url.replace(/虚拟局域网$/, "").trim()));
  check(
    "面板给出同事该打开的地址（可复制），现场照念第一条",
    lanUrls.length >= 1 && /现场默认念第一条/.test(panel?.text ?? ""),
    `地址 ${lanUrls.length} 条：${lanUrls.slice(0, 3).join(" ／ ")}`,
  );
  const expectVpn = (recommended.peers?.addresses ?? []).some((item) => item.kind === "vpn");
  check(
    "虚拟局域网地址也列出来了（不在同一局域网、但在同一虚拟网里的同事用这条）",
    !expectVpn || (panel?.vpnUrls?.length ?? 0) >= 1,
    expectVpn ? `虚拟局域网条目：${(panel?.vpnUrls ?? []).join(" ／ ")}` : "这一台没有虚拟局域网网卡，如实为空",
  );
  const endsText = (panel?.ends ?? []).join(" ｜ ");
  check(
    "端明细里两台都在（各自的对端地址 + 账号 + 在哪一页 + 还有没有动静）",
    (panel?.ends?.length ?? 0) >= 2 &&
      endsText.includes("127.0.0.1") &&
      endsText.includes(new URL(PEER_BASE).hostname) &&
      (panel?.ends ?? []).every((line) => /·.*·.*· 已开 .*· .*有动静/.test(line)),
    `${panel?.ends?.length ?? 0} 台：${endsText}`,
  );

  /* 实测：点面板里的按钮，等结论（端回执是异步的） */
  await A.evaluate(`(() => {
    const btn = [...document.querySelectorAll('.cs-lan-panel button')].find((b) => /开一次实测|等端回执/.test(b.textContent || ''));
    btn?.click();
    return Boolean(btn);
  })()`);
  let verdict = "";
  for (let i = 0; i < 40; i += 1) {
    await sleep(300);
    panel = await A.evaluate(PANEL_PROBE);
    verdict = rowText("同步实测");
    /* 追回执期间是「等端回执 M/N」这个中间态，结论要等端回齐（或超时）才算数 */
    if (/写入→全网可见 \d+\/\d+ 台|只有 \d+\/\d+ 台收到/.test(verdict) && !verdict.includes("等端回执")) break;
  }
  const latestProbe = await A.call("GET", "/api/console/sync-probe");
  const probeEnds = latestProbe.json?.probe?.ends ?? 0;
  const probeAcked = latestProbe.json?.probe?.acked?.length ?? 0;
  check(
    "「开一次实测」给出可证伪的结论：这条写入几台端真收到了",
    /* 这一格读到的是一行文本（按钮 + 结论文案），所以按"句子里有没有这句结论"判 */
    /写入→全网可见 \d+\/\d+ 台（[\d.]+ 秒）|只有 \d+\/\d+ 台收到/.test(verdict) && !verdict.includes("等端回执"),
    verdict || "（面板上没有结论）",
  );
  check(
    "实测里至少两台端回了执（就是这两台真浏览器），没回的端也点了名",
    probeEnds >= 2 && probeAcked >= 2 && probeAcked + (latestProbe.json?.probe?.pending?.length ?? 0) === probeEnds,
    `下发时 ${probeEnds} 台 · 回执 ${probeAcked} 台 · 没回 ${(latestProbe.json?.probe?.pending ?? []).map((item) => item.address).join(" / ") || "（无）"}`,
  );

  /* 写入来源：两台机器各自的写入都要在里面 */
  let writes = panel?.writes ?? [];
  for (let i = 0; i < 20 && !writes.some((row) => row[3]?.includes(new URL(PEER_BASE).hostname)); i += 1) {
    await sleep(300);
    panel = await A.evaluate(PANEL_PROBE);
    writes = panel?.writes ?? [];
  }
  const fromSelf = writes.filter((row) => row[3] === "127.0.0.1").length;
  const fromPeer = writes.filter((row) => row[3] === new URL(PEER_BASE).hostname).length;
  check(
    "「最近写入来源」里同时有本机与队友那台的写入 —— 他到底写没写进来，一眼看到",
    fromSelf >= 1 && fromPeer >= 1,
    `来自本机 ${fromSelf} 条 · 来自队友那台 ${fromPeer} 条；最近几条：${writes
      .slice(0, 4)
      .map((row) => `${row[0]} ${row[1]} ${row[2]}@${row[3]}`)
      .join(" ／ ")}`,
  );

  await A.evaluate(`document.querySelector('.cs-lan-panel')?.scrollIntoView({ block: 'center' })`);
  await sleep(400);
  const shotA = await A.shot("1-内网协同-两台在线");
  const shotB = await B.shot("2-队友那台-工单页");
  if (shotA) console.log(`\n  截图：${shotA}`);
  if (shotB) console.log(`  截图：${shotB}`);

  /* ---------- ⑥ 删除也同步（B 台删 → A 台那一行自己消失） ---------- */
  if (createdId) {
    const del = await B.call("DELETE", `/api/work-orders/${createdId}`);
    let gone = false;
    for (let i = 0; i < 60; i += 1) {
      const now = await A.evaluate(ORDERS_PROBE);
      if (!now.numbers.includes(createdNo)) {
        gone = true;
        break;
      }
      await sleep(250);
    }
    check("B 台删单后，A 台那一行**不刷新**就自己收走了", gone, `HTTP ${del.status}`);
    if (gone) createdId = "";
  }
} catch (error) {
  console.error(`\n验收中断：${error?.message ?? error}`);
  fail += 1;
} finally {
  /* 兜底清理：验收失败也不能把临时工单留在库里 */
  if (createdId) {
    try {
      await A.call("DELETE", `/api/work-orders/${createdId}`);
    } catch {
      /* 尽力而为 */
    }
  }
  A.kill();
  B?.kill();
}

console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项未通过`}（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
