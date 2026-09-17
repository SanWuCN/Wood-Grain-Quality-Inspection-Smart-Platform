/**
 * 剧本快捷键 · 气泡与逐字显示 端到端验收
 *
 * ── 为什么写这个（用户实测报的 bug）────────────────────────────────
 * 原话：「小木现在用快捷键唤醒有个问题，点击的时候小木应该有正在录入的样子，
 *        应该弹出气泡显示逐渐接收消息，我这边实测下来是小木没反应，
 *        过一会儿突然就接收到一整句话。」
 *
 * 根因（已定位）：`useScriptShortcut` 只把逐字文本写进 `agent.partial`，**从不置 `open`**；
 * 而气泡面板的门控是 `if (!agent.open && !expanded) return;`（`XiaomuDock.tsx:359`）。
 * 于是那串 partial 一直在 store 里累积，屏幕上**没有容器显示它**，
 * 直到 `ask()` 收尾才看到整句 —— 与用户描述完全一致。
 *
 * ── 判据（都能证伪，不是"看着像"）──────────────────────────────────
 *   ① 按下 Ctrl+Q+1 后 **400ms 内**气泡面板出现在 DOM 里（`visible` 变真）；
 *   ② 识别期间用户气泡里的文字**至少出现 3 个不同长度**（逐字累积；
 *      若只在最后一次性出现，这条必红 —— 那正是本次修的 bug）；
 *   ③ 采样到的最大长度**小于**该句总长度（证明是"逐渐"，不是"一次给完"）；
 *   ④ 随后小木的回复出现（`ask()` 链路真的跑通了，不是只画了个空泡）。
 *
 * ⚠ 判断"逐字"**不能用"帧间有变化"**：那条件在动画/浮动下恒真（见 voice-module/AGENTS.md
 *   记的假绿教训）。这里用**文本长度序列**，它是单调递增的离散量，能证伪。
 *
 * 前置：8000（或 5173）在跑。
 * 用法：node 'D:\平台\voice-module\tools\验收-快捷键气泡.mjs' [--url http://127.0.0.1:8000/]
 */
import { existsSync, rmSync } from "node:fs";

const args = process.argv.slice(2);
const urlIndex = args.indexOf("--url");
const PAGE = urlIndex >= 0 ? args[urlIndex + 1] : "http://127.0.0.1:8000/";
const PORT = 9502;
const PROFILE = `${process.env.TEMP}\\mumai-shortcut-bubble-profile`;

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
    "--autoplay-policy=no-user-gesture-required",
    "--mute-audio",
    "--window-size=1440,900",
    PAGE,
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForTarget(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  const want = new URL(PAGE);
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(
        (t) => t.type === "page" && t.webSocketDebuggerUrl && t.url.startsWith(want.origin),
      );
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error("等不到可调试的页面（服务在跑吗？）");
}

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `　（${detail}）` : ""}`);
  if (!ok) failed += 1;
};

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
    const r = await send("Runtime.evaluate", {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description ?? "页面内抛错");
    }
    return r.result?.result?.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");

  /* ---------- 登录（账号来自 start-platform.cmd 的说明）---------- */
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
    const st = await evaluate(
      `({ hash: location.hash, nav: document.querySelectorAll('nav button, nav a, aside button').length })`,
    );
    if (st && !String(st.hash).includes("login") && st.nav > 0) {
      inApp = true;
      break;
    }
    await sleep(500);
  }
  check("登录成功并进入平台页面", inApp, `hash=${await evaluate(`location.hash`)}`);

  /* 采集"气泡是否在"与"用户气泡文字"的取样器，注入页面供轮询调用 */
  await evaluate(`(() => {
    window.__probe = () => {
      const panel = document.querySelector('.xd__panel');
      const bubbles = document.querySelectorAll('.xd__panel .xd__user, .xd__panel [class*="user"]');
      const texts = [...bubbles].map((el) => (el.textContent || '').trim()).filter(Boolean);
      return {
        panelShown: Boolean(panel),
        state: (document.querySelector('.xd__state')?.textContent || '').trim(),
        userTexts: texts,
      };
    };
    return true;
  })()`);

  /* ---------- 触发 Ctrl+Q+1 ---------- */
  const dispatch = (key) =>
    evaluate(`(() => {
      const opts = { key: ${JSON.stringify(key)}, code: 'Key' + ${JSON.stringify(key.toUpperCase())},
                     ctrlKey: true, bubbles: true, cancelable: true };
      window.dispatchEvent(new KeyboardEvent('keydown', opts));
      return true;
    })()`);

  const T0 = Date.now();
  await dispatch("q");
  await dispatch("1");

  /* ---------- ① 气泡是否很快出现 ---------- */
  let appearMs = -1;
  for (let i = 0; i < 40; i += 1) {
    const p = await evaluate(`window.__probe()`);
    if (p?.panelShown) {
      appearMs = Date.now() - T0;
      break;
    }
    await sleep(50);
  }
  check("按下快捷键后气泡面板出现", appearMs >= 0, appearMs >= 0 ? `${appearMs}ms` : "始终没出现");
  check("气泡在 400ms 内出现（现场「有反应」的手感）", appearMs >= 0 && appearMs <= 400, `${appearMs}ms`);

  /* ---------- ②③ 逐字累积：采样文字长度序列 ---------- */
  const lengths = [];
  const states = new Set();
  for (let i = 0; i < 60; i += 1) {
    const p = await evaluate(`window.__probe()`);
    if (p) {
      states.add(p.state);
      const longest = Math.max(0, ...p.userTexts.map((t) => t.length));
      if (longest > 0) lengths.push(longest);
    }
    await sleep(80);
  }
  const uniq = [...new Set(lengths)].sort((a, b) => a - b);
  check(
    "识别期间文字逐字累积（≥3 个不同长度）",
    uniq.length >= 3,
    `长度序列 ${uniq.slice(0, 8).join("→")}${uniq.length > 8 ? "…" : ""}`,
  );
  check(
    "最大长度小于整句（证明「逐渐」而不是「一次给完」）",
    uniq.length > 0 && uniq[uniq.length - 1] < 60,
    `最大 ${uniq[uniq.length - 1] ?? 0} 字`,
  );
  console.log(`    识别期间出现过的状态：${[...states].filter(Boolean).join(" / ") || "（无）"}`);

  /* ---------- ④ 小木的回复最终出现 ---------- */
  let replied = false;
  for (let i = 0; i < 80; i += 1) {
    const p = await evaluate(`(() => {
      const t = document.querySelector('.xd__panel');
      return { shown: Boolean(t), text: (t?.textContent || '') };
    })()`);
    if (p?.shown && /四项任务|现场建档/.test(p.text)) {
      replied = true;
      break;
    }
    await sleep(250);
  }
  check("随后小木给出该轮回复（ask 链路跑通）", replied);

  await evaluate(`window.__probe = undefined`);
} finally {
  chrome.kill();
}

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项未通过`}`);
process.exit(failed === 0 ? 0 : 1);
