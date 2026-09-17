/**
 * 内网同步验收 · **浏览器视角**（这才是用户看到的那一面）
 *
 * ── 与另外两个验收的分工 ────────────────────────────────────────────
 *   `验收-多机协同.mjs`    ：三台"机器"（fetch 客户端）打同一台服务器 —— 证服务端数据是共享的；
 *   `验收-内网实时推送.mjs`：一条裸 WebSocket —— 证事件真的推得出去、断线补得回来；
 *   **本脚本**            ：一台**真浏览器**（生产构建）+ 一个"另一台机器"的 HTTP 客户端 ——
 *                          证"别人建的单/改的调度，我这边的页面**不刷新**就自己变了"。
 *
 * 用户需求原话：「我这边按出新工单，别人那边得有，然后别人那选择人员调度，我这边得同步」。
 *
 * 判据（都能证伪）：
 *   ① 页面登录后顶栏「平台」状态是**正常**（浏览器到共享服务的实时通道是通的）；
 *   ② 另一台机器建单后，本页工单列表里**自动出现**该单号 —— 全程不调 Page.reload；
 *   ③ 另一台机器调度（指派负责人）后，列表里那一行的负责人从「未指派负责人」变成岗位名；
 *   ④ 该单被删除后，那一行自动消失（删除事件也同步）。
 *
 * 前置：8000 在跑（`node server/index.mjs --static dist`）。
 * 用法：node tools/验收-内网同步-浏览器.mjs [--base http://192.168.31.202:8000]
 */
import { existsSync, rmSync } from "node:fs";

const baseArg = process.argv.indexOf("--base");
const BASE = baseArg >= 0 ? process.argv[baseArg + 1] : "http://127.0.0.1:8000";
const PASSWORD = "123456";
const PORT = 9511;
const PROFILE = `${process.env.TEMP}\\mumai-lan-sync-profile`;

function findChrome() {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error("找不到 Chrome / Edge");
  return hit;
}

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `　（${detail}）` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 截个图存盘（证据图）。判据是数字，但"长什么样"只有图能说明 ——
 * 用户要看的就是那几行字（在线端数、该念的地址）。
 */
const SHOT_DIR = "D:\\平台\\_归档-临时产物-20260917";
async function shot(send, name) {
  try {
    const r = await send("Page.captureScreenshot", { format: "png" });
    const data = r?.result?.data;
    if (!data) return null;
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(SHOT_DIR, { recursive: true });
    const file = `${SHOT_DIR}\\内网同步-${name}.png`;
    writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  } catch {
    return null;
  }
}

/* ---------- "另一台机器"：一个独立的 HTTP 客户端（沈） ---------- */
function machine(account) {
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
    return { status: r.status, json };
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

rmSync(PROFILE, { recursive: true, force: true });
const { spawn } = await import("node:child_process");
const chrome = spawn(
  findChrome(),
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
    "--mute-audio",
    "--window-size=1440,900",
    `${BASE}/`,
  ],
  { stdio: "ignore" },
);

async function waitForTarget(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  const want = new URL(BASE);
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl && t.url.startsWith(want.origin));
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error("等不到可调试的页面（服务在跑吗？）");
}

let newId = "";
let newNo = "";
try {
  const ws = new WebSocket(await waitForTarget());
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const waiting = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (waiting.has(m.id)) {
      waiting.get(m.id)(m);
      waiting.delete(m.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      waiting.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "页面内抛错");
    return r.result?.result?.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");

  console.log(`目标服务器：${BASE}（页面 = 真浏览器，另一台机器 = HTTP 客户端）\n`);

  /* ---------- 登录（史）---------- */
  for (let i = 0; i < 60; i += 1) {
    if (await evaluate(`Boolean(document.querySelector('input'))`)) break;
    await sleep(500);
  }
  await evaluate(`(async () => {
    const inputs = [...document.querySelectorAll('input')];
    if (inputs.length < 2) return false;
    const setValue = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setValue(inputs[0], 'shi');
    setValue(inputs[1], '123456');
    const form = inputs[0].closest('form');
    if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
    return true;
  })()`);
  let inApp = false;
  for (let i = 0; i < 60; i += 1) {
    const st = await evaluate(`({ hash: location.hash, nav: document.querySelectorAll('nav button, nav a, aside button').length })`);
    if (st && !String(st.hash).includes("login") && st.nav > 0) {
      inApp = true;
      break;
    }
    await sleep(500);
  }
  check("真浏览器登录成功并进入平台", inApp, `hash=${await evaluate(`location.hash`)}`);

  /* ---------- ① 顶栏「平台」实时通道状态 ---------- */
  const probe = `(() => {
    /* 顶栏状态条的每一项 = 一个 button：标签在 .appshell__channels-label，值在 StatusChip 里 */
    const strip = document.querySelector('.appshell__channels');
    let platform = '';
    if (strip) {
      for (const btn of strip.querySelectorAll('button')) {
        const label = (btn.querySelector('.appshell__channels-label')?.textContent || '').trim();
        if (label === '平台') {
          platform = (btn.textContent || '').replace(label, '').trim();
          break;
        }
      }
    }
    const rows = [...document.querySelectorAll('.orders-side .orders-history .order-item')];
    return {
      hash: location.hash,
      platform,
      count: rows.length,
      numbers: rows.map((r) => (r.querySelector('b')?.textContent || '').trim()),
      leaders: rows.map((r) => (r.querySelector('.wop-row__status em')?.textContent || '').trim()),
    };
  })()`;

  /* 进工单档案页（列表 + 状态都在这一页） */
  await evaluate(`location.hash = '#/orders'`);
  await sleep(1200);
  let before = await evaluate(probe);
  for (let i = 0; i < 40 && before.count === 0; i += 1) {
    await sleep(250);
    before = await evaluate(probe);
  }
  check("工单列表已渲染（不是空页）", before.count > 0, `${before.count} 条`);
  check(
    "顶栏「平台」显示实时通道正常（WebSocket 已连上）",
    before.platform.includes("正常"),
    `读到「${before.platform}」`,
  );

  /* ---------- ② 另一台机器建单 → 本页不刷新就出现 ---------- */
  const M = machine("shen");
  const loginOk = await M.login();
  check("另一台机器（沈）登录成功", loginOk);

  const eventId = `lan-${Date.now().toString(36)}`;
  const created = await M.call("POST", "/api/work-orders/trigger", { eventId });
  newId = created.json?.orderId ?? "";
  newNo = created.json?.orderNo ?? "";
  console.log(`\n  另一台机器建单：HTTP ${created.status}　${newNo}（${newId}）`);

  let appeared = false;
  for (let i = 0; i < 60; i += 1) {
    const now = await evaluate(probe);
    if (now.numbers.includes(newNo)) {
      appeared = true;
      break;
    }
    await sleep(250);
  }
  check(
    "本页**不刷新**就出现了新工单（workOrder.created 事件驱动）",
    appeared,
    appeared ? `${before.count} → ${(await evaluate(probe)).count} 条` : `列表里没有 ${newNo}`,
  );
  check("全程没有重新加载页面（hash 未变、无 Page.reload）", (await evaluate(`location.hash`)) === "#/orders");

  /* ---------- ③ 调度同步（列表里的负责人自己变） ---------- */
  if (newId) {
    const assign = await M.call("PUT", `/api/work-orders/${newId}/assignment`, {
      leaderAccountId: "ma",
      members: [{ accountId: "rao", duties: [] }],
      note: "内网同步验收（浏览器）",
    });
    let leader = "";
    for (let i = 0; i < 60; i += 1) {
      const now = await evaluate(probe);
      const idx = now.numbers.indexOf(newNo);
      leader = idx >= 0 ? now.leaders[idx] : "";
      if (leader && leader !== "未指派负责人") break;
      await sleep(250);
    }
    check(
      "本页**不刷新**就同步了人员调度（负责人不再是「未指派负责人」）",
      Boolean(leader) && leader !== "未指派负责人",
      `HTTP ${assign.status}；负责人=「${leader}」`,
    );
  }

  /* ---------- ④ 删除同步（那一行自己消失） ---------- */
  if (newId) {
    const del = await M.call("DELETE", `/api/work-orders/${newId}`);
    let gone = false;
    for (let i = 0; i < 60; i += 1) {
      const now = await evaluate(probe);
      if (!now.numbers.includes(newNo)) {
        gone = true;
        break;
      }
      await sleep(250);
    }
    check("本页**不刷新**就把被删的那一行收走了", gone, `HTTP ${del.status}`);
  }

  /* ---------- ⑤ 排练控制台「内网协同」：同事该念的地址 + 在线端数 ----------
     用户口径 2026-09-17「完善平台内网同步」：现场要能一眼看到
     「别人连上了没有」和「同事该打开哪个地址」，而不是去 ipconfig 里翻。
  */
  await evaluate(`location.hash = '#/console'`);
  await sleep(1500);
  const lanProbe = `(() => {
    const panel = document.querySelector('.cs-lan-panel');
    if (!panel) return { found: false };
    const url = panel.querySelector('.cs-lan__url');
    const text = (panel.textContent || '').replace(/\\s+/g, ' ').trim();
    const m = text.match(/(\\d+)\\s*台/);
    return { found: true, url: url ? (url.textContent || '').trim() : '', peers: m ? Number(m[1]) : null, text };
  })()`;
  let lan = await evaluate(lanProbe);
  for (let i = 0; i < 40 && !lan?.found; i += 1) {
    await sleep(250);
    lan = await evaluate(lanProbe);
  }
  check("排练控制台有「内网协同」面板", Boolean(lan?.found));
  check(
    "面板给出内网地址（同事照着打开即可）",
    /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/.test(String(lan?.url ?? "")),
    `地址=「${lan?.url ?? ""}」`,
  );
  check(
    "面板显示真实在线端数（本机这条通道在内，≥1）",
    Number(lan?.peers ?? 0) >= 1,
    `读数=${lan?.peers ?? "?"} 台　原文「${String(lan?.text ?? "").slice(0, 60)}…」`,
  );
  /* 截图前先滚到那一块：这一页在小窗口下是竖向堆叠的，面板在首屏之外 */
  await evaluate(`document.querySelector('.cs-lan-panel')?.scrollIntoView({ block: 'center' })`);
  await sleep(400);
  await shot(send, "1-排练控制台-内网协同");
} catch (error) {
  console.error(`\n验收中断：${error.message}`);
  fail += 1;
} finally {
  /* 兜底清理：验收失败也不能把临时工单留在库里 */
  if (newId) {
    try {
      const M = machine("shen");
      await M.login();
      await M.call("DELETE", `/api/work-orders/${newId}`);
    } catch {
      /* 尽力而为 */
    }
  }
  chrome.kill();
}

console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项未通过`}（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
