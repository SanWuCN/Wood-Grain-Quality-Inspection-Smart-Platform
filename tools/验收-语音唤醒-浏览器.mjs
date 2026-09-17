/**
 * 语音唤醒 · **浏览器视角**验收（生产服务 8000 上）
 *
 * 用户口径（2026-09-17）：「我现在语音识别功能是被剔除了吗」。
 * 事实：本地识别链路一直在跑（Python 8770 ← 桥接层 8780），
 * 但 `/voice-*` 的代理原来只写在 `vite.config.ts` 里 —— 只有从 5173 打开时语音才通，
 * 从 8000（生产 / 内网地址）打开时 `/voice-wake` 的 upgrade 没人认、socket 直接被销毁。
 *
 * 所以本脚本要证的**只有一件事**：在 8000 上，浏览器真的把这三条语音通道连上了。
 * 判据（都能证伪，且不依赖"听见声音"）：
 *   ① 页面加载时注入的探针记录了 `new WebSocket` 的实际 URL —— 必须出现 `/voice-wake`；
 *   ② 点「开启常驻唤醒」后，那条连接必须到达 **OPEN**（被 destroy 的话状态永远不是 1）；
 *   ③ 气泡底部的按钮文案变成「常驻唤醒：已开」（只有通道 live 才会变）；
 *   ④ 反证：探针同时记录了 `/ws`（事件通道）也连上了 —— 说明不是"所有 WS 都通"的假绿。
 *
 * ⚠ 用假麦克风（`--use-fake-device-for-media-stream`）只是为了**给得出权限**，
 *   不是为了验证唤醒词识别 —— 假设备放的是提示音，喊不动「小木小木」。
 *   "能连上通道"与"能识别唤醒词"是两件事，这里只证前者（后者要靠真人对着麦克风说）。
 *
 * 用法：node tools/验收-语音唤醒-浏览器.mjs [--base http://127.0.0.1:8000]
 */
import { existsSync, rmSync } from "node:fs";

const baseArg = process.argv.indexOf("--base");
const BASE = baseArg >= 0 ? process.argv[baseArg + 1] : "http://127.0.0.1:8000";
const PORT = 9513;
const PROFILE = `${process.env.TEMP}\\mumai-wake-profile`;
const SHOT_DIR = "D:\\平台\\_归档-临时产物-20260917";

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `　（${detail}）` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    /* 假麦克风 + 自动授权：无头环境里没有真麦克风，但"能不能连上通道"与设备无关 */
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
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
  /*
    探针必须在**页面脚本之前**注入：WebSocket 是在应用启动时就连的，
    晚一步就抓不到那一次 `new WebSocket`。
  */
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__voiceSockets = [];
      const Orig = window.WebSocket;
      window.WebSocket = function (url, protocols) {
        const sock = new Orig(url, protocols);
        const rec = { url: String(url), state: null, opened: false, closed: false, error: false };
        window.__voiceSockets.push(rec);
        const sync = () => { rec.state = sock.readyState; };
        sync();
        sock.addEventListener("open", () => { rec.opened = true; sync(); });
        sock.addEventListener("close", () => { rec.closed = true; sync(); });
        sock.addEventListener("error", () => { rec.error = true; sync(); });
        setInterval(sync, 500);
        return sock;
      };
      window.WebSocket.prototype = Orig.prototype;
      window.WebSocket.CONNECTING = Orig.CONNECTING;
      window.WebSocket.OPEN = Orig.OPEN;
      window.WebSocket.CLOSING = Orig.CLOSING;
      window.WebSocket.CLOSED = Orig.CLOSED;
    `,
  });
  /* 探针注入后必须**重新加载**才会对新文档生效 */
  await send("Page.reload", { ignoreCache: false });
  await sleep(1500);

  console.log(`目标服务器：${BASE}（真浏览器 + 假麦克风）\n`);

  /* ---------- 登录 ---------- */
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
  check("真浏览器登录成功", inApp, `hash=${await evaluate(`location.hash`)}`);

  /* ---------- 打开气泡并点「开启常驻唤醒」 ---------- */
  await evaluate(`(() => {
    if (!document.querySelector('.xd__panel')) document.querySelector('.xd__avatar')?.click();
    return true;
  })()`);
  await sleep(600);
  const clicked = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.xd__btn')].find((b) => (b.textContent || '').includes('常驻唤醒'));
    if (!btn) return 'no-button';
    btn.click();
    return 'clicked';
  })()`);
  check("气泡里有「开启常驻唤醒」按钮并已点击", clicked === "clicked", clicked);

  /* ---------- ①② 唤醒通道：必须出现 /voice-wake 且到达 OPEN ---------- */
  let wake = null;
  for (let i = 0; i < 60; i += 1) {
    const list = await evaluate(`window.__voiceSockets.map((r) => ({ url: r.url, opened: r.opened, closed: r.closed, error: r.error, state: r.state }))`);
    wake = list.find((s) => s.url.includes("/voice-wake"));
    if (wake?.opened) break;
    await sleep(500);
  }
  check(
    "浏览器真的发起了 /voice-wake 连接",
    Boolean(wake),
    wake ? wake.url : "没有抓到这条连接（说明通道根本没被使用）",
  );
  check(
    "该连接到达 OPEN（不是被 upgrade 路由 destroy）",
    Boolean(wake?.opened) && wake?.state === 1,
    wake ? `opened=${wake.opened} closed=${wake.closed} error=${wake.error} readyState=${wake.state}` : "无",
  );

  /* ---------- ③ 界面文案跟着变 ---------- */
  let label = "";
  for (let i = 0; i < 40; i += 1) {
    label = await evaluate(`(() => {
      const btn = [...document.querySelectorAll('.xd__btn')].find((b) => (b.textContent || '').includes('常驻唤醒'));
      return btn ? (btn.textContent || '').trim() : '';
    })()`);
    if (label.includes("已开")) break;
    await sleep(500);
  }
  check("气泡按钮变成「常驻唤醒：已开」（通道 live 的表现）", label.includes("已开"), `按钮=「${label}」`);

  const stateNote = await evaluate(`(() => {
    const el = document.querySelector('.xd__state');
    return el ? (el.textContent || '').trim() : '';
  })()`);
  console.log(`    当前小木状态：${stateNote || "（无）"}`);

  /* ---------- ④ 反证：事件通道也开着（不是"所有 WS 都通"的假绿） ----------
     ⚠ 这一条要**最后**再查：事件通道由共享 store 在登录后拉起，早查会拿到空列表，
     第一版就是这么假红的（不是它没连，是我问得太早）。
  */
  let eventSock = null;
  for (let i = 0; i < 40; i += 1) {
    const list = await evaluate(`window.__voiceSockets.map((r) => ({ url: r.url, opened: r.opened, state: r.state }))`);
    eventSock = list.find((s) => /\/ws\?/.test(s.url));
    if (eventSock?.opened) break;
    await sleep(500);
  }
  check(
    "事件通道 /ws 也连上了（反证基线）",
    Boolean(eventSock?.opened),
    eventSock ? `${eventSock.url.slice(0, 60)}… readyState=${eventSock.state}` : "没抓到 /ws 连接",
  );

  /* 证据图 */
  try {
    const r = await send("Page.captureScreenshot", { format: "png" });
    if (r?.result?.data) {
      const { writeFileSync, mkdirSync } = await import("node:fs");
      mkdirSync(SHOT_DIR, { recursive: true });
      writeFileSync(`${SHOT_DIR}\\语音唤醒-1-常驻唤醒已连上.png`, Buffer.from(r.result.data, "base64"));
    }
  } catch {
    /* 截图失败不影响判据 */
  }
} catch (error) {
  console.error(`\n验收中断：${error.message}`);
  fail += 1;
} finally {
  chrome.kill();
}

console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项未通过`}（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
