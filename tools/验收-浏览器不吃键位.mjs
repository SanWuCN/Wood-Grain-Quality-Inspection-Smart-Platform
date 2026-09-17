/**
 * 验收：键位与浏览器有没有冲突 —— **分两套机制各证各的**（别让"空跑"混成绿灯）
 *
 * ── 为什么必须单独一个工装 ──────────────────────────────────────────
 * 用户为"键位和浏览器撞了"先后换过两次键位：
 *   · 「ctrl加n换成加j的，ctrl加n有功能冲突了」—— `Ctrl+N` 是浏览器**保留键**（新建窗口），
 *     页面 `preventDefault` 也拦不住；
 *   · 「找个没冲突的替代j」—— `Ctrl+J` 是下载页。
 *
 * 而 `验收-快捷键气泡.mjs` 里按键用的是 `window.dispatchEvent(new KeyboardEvent(...))`：
 * **合成事件永远不会触发浏览器自己的快捷键**，所以那里"没把浏览器带走"是**空跑**。
 *
 * ── 两套机制（各自只有一套机制证得了）──────────────────────────────
 *   甲、**浏览器到底认不认这个组合** —— 只能用 CDP `Input.dispatchKeyEvent`（真实输入通道，
 *       与手按走同一套加速键判定）在**登录页**上测：那时页面上还没有我们的 handler，
 *       所以"没动静"只可能是浏览器本来就没动作，不是被我们拦掉的。
 *        ① `Ctrl+N` → 必须开出新窗口（证明真实按键确实会触发浏览器命令，检测有效）；
 *        ② `Ctrl+Shift+B` → 必须切书签栏（证明"浏览器 UI 动了"看得见，检测有效）；
 *        ③ `Ctrl+B` / `Ctrl+Y` / `Ctrl+M` / `Ctrl+Shift+Z` → 不许有任何动静
 *          （这就是"选它们当键位"的依据：浏览器本来就不认）。
 *   乙、**我们的 handler 拦了哪些键** —— 用注入的 `preventDefault` 审计 + 合成事件测
 *       （合成事件一定送得到页面，不看系统焦点；真实按键送不送得到渲染进程要看窗口在不在前台，
 *        实测时灵时不灵，因此不用它来证这一半）：
 *        ④ 段前缀 / 段内数字 / 一条龙 → 必须被拦下；
 *        ⑤ `Ctrl+Shift+B` / `Ctrl+Shift+Y` / 单独的 `Ctrl+1` → 必须**不**被我们拦
 *          （不抢浏览器自己的组合）。
 *          ⚠ 这一条正是 2026-09-17 用真实按键查出来的老问题：`event.key` 按住 Shift 是大写，
 *            旧判定 `toLowerCase()` 后照样命中段前缀 —— `Ctrl+Shift+B` 被当成"1–10 段待命"
 *            并 `preventDefault()`，把书签栏开关吃掉。修完必须由这条断言钉住。
 *
 * ⚠ 这个工装**不用 headless**：headless 下浏览器级快捷键不一定生效，对照 ①② 就失去意义。
 *   它会真的开一个 900×600 的窗口，跑完自动关掉。
 *
 * 前置：8000 在跑。用法：node tools/验收-浏览器不吃键位.mjs [--url http://127.0.0.1:8000/]
 */
import { existsSync, rmSync } from "node:fs";

const args = process.argv.slice(2);
const urlIndex = args.indexOf("--url");
const PAGE = urlIndex >= 0 ? args[urlIndex + 1] : "http://127.0.0.1:8000/";
const PORT = 9503;
const PROFILE = `${process.env.TEMP}\\mumai-browser-keys-profile`;

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
    /* 刻意不加 --headless=new：见文件头说明（headless 下对照 ①② 不可信） */
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--window-size=900,600",
    "--window-position=0,0",
    "--autoplay-policy=no-user-gesture-required",
    "--mute-audio",
    PAGE,
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ⚠ 这里**不许**把失败吞成空数组：拿不到目标列表，一切"没变化"都是假的绿灯 */
async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  if (!res.ok) throw new Error(`调试端口返回 ${res.status}`);
  return res.json();
}

/** 只在"等浏览器起来"的那几秒里用：端口还没监听不算错 */
async function tryListTargets() {
  try {
    return await listTargets();
  } catch {
    return [];
  }
}

async function closeTarget(id) {
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/close/${id}`);
  } catch {
    /* 关不掉就算了：计数用 id 集合，不受影响 */
  }
}

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `　（${detail}）` : ""}`);
  if (!ok) failed += 1;
};
const note = (text) => console.log(`    · ${text}`);
const section = (title) => console.log(`\n【${title}】`);

try {
  /* ---------- 连上页面 ---------- */
  let page = null;
  for (let i = 0; i < 80; i += 1) {
    const want = new URL(PAGE);
    page = (await tryListTargets()).find(
      (t) => t.type === "page" && t.webSocketDebuggerUrl && t.url.startsWith(want.origin),
    );
    if (page) break;
    await sleep(250);
  }
  if (!page) throw new Error("等不到可调试的页面（8000 在跑吗？）");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
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
    if (r.result?.exceptionDetails) throw new Error(`页面内抛错：${r.result.exceptionDetails.text ?? ""}`);
    return r.result?.result?.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");

  /* ---------- 甲：真实输入（CDP），只在"浏览器认不认这个组合"上用 ---------- */
  const KEY = {
    b: { key: "b", code: "KeyB", vk: 66 },
    y: { key: "y", code: "KeyY", vk: 89 },
    m: { key: "m", code: "KeyM", vk: 77 },
    z: { key: "z", code: "KeyZ", vk: 90 },
    n: { key: "n", code: "KeyN", vk: 78 },
  };
  /** 真实按一下 Ctrl[+Shift]+<k>（modifiers: 2=Ctrl、8=Shift） */
  const realTap = async (k, { ctrl = true, shift = false } = {}) => {
    const spec = KEY[k];
    if (!spec) throw new Error(`没登记这个键：${k}`);
    const modifiers = (ctrl ? 2 : 0) | (shift ? 8 : 0);
    const base = {
      modifiers,
      /* 按住 Shift 时 DOM 的 key 是大写（真实按键如此）：照实写，
         否则浏览器自己的 Ctrl+Shift+<字母> 加速键可能匹配不上 */
      key: shift ? spec.key.toUpperCase() : spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.vk,
      nativeVirtualKeyCode: spec.vk,
    };
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  };

  /**
   * 一次测量：页面**按 id** 记账 / 地址 / 可视高度。
   *
   * ⚠ 必须按 id 记账，不能拿 `${id} ${url}` 当身份：应用自己的 hash 跳转
   * （`#/` → `#/login`）会让"同一个页面"看起来像"新页面"，
   * 于是把主页面当成新窗口关掉 —— 那样整个浏览器会被关掉（只剩一扇窗时就是退出）。
   */
  const snapshot = async () => {
    const list = await listTargets();
    return {
      pages: new Map(list.filter((t) => t.type === "page").map((t) => [t.id, t.url])),
      url: await evaluate(`location.href`),
      innerHeight: await evaluate(`window.innerHeight`),
    };
  };
  const diff = (before, after) => ({
    fresh: [...after.pages.keys()]
      .filter((targetId) => !before.pages.has(targetId))
      .map((targetId) => `${targetId} ${after.pages.get(targetId)}`),
    gone: [...before.pages.keys()].filter((targetId) => !after.pages.has(targetId)),
    urlChanged: String(after.url) !== String(before.url),
    heightDelta: Number(after.innerHeight) - Number(before.innerHeight),
  });
  /** 真实按一下并等一会儿（Ctrl+N 那种全局命令不一定立刻完成） */
  const realTapAndWatch = async (k, opts = {}) => {
    const before = await snapshot();
    await realTap(k, opts);
    let after = await snapshot();
    for (let i = 0; i < 20 && !diff(before, after).fresh.length; i += 1) {
      await sleep(150);
      after = await snapshot();
    }
    return { before, after, d: diff(before, after) };
  };
  /** 关掉**新开**的窗口；绝不碰当前这一页（它一关，浏览器就退了） */
  const cleanFresh = async (d) => {
    for (const t of d.fresh) {
      if (t.split(" ")[0] === page.id) continue;
      await closeTarget(t.split(" ")[0]);
    }
    await sleep(400);
  };

  /* ---------- 甲①②：先证明"真实按键 / 浏览器 UI 变化"都看得见 ---------- */
  section("甲 · 真实输入：先在登录页上证明检测看得见浏览器自己的动作");
  const r1 = await realTapAndWatch("n");
  check(
    "对照 ①：真实按键能触发浏览器命令（Ctrl+N 开出新窗口）",
    r1.d.fresh.length > 0,
    r1.d.fresh.length ? `新增 ${r1.d.fresh.map((t) => t.split(" ")[1]).join(" / ")}` : "什么都没发生（检测不可信）",
  );
  await cleanFresh(r1.d);

  const beforeB = await snapshot();
  await realTap("b", { shift: true });
  await sleep(700);
  const afterB = await snapshot();
  const dB = diff(beforeB, afterB);
  check(
    "对照 ②：浏览器自己的 UI 变化看得见（Ctrl+Shift+B 切换书签栏 → 可视高度变化）",
    dB.heightDelta !== 0,
    `可视高度 ${beforeB.innerHeight} → ${afterB.innerHeight}（Δ${dB.heightDelta}）`,
  );
  await realTap("b", { shift: true }); /* 切回去 */
  await sleep(500);

  /* ---------- 甲③：我们的键位，浏览器本来就不认 ---------- */
  section("甲 · 真实输入：我们的键位在浏览器里本来就没有动作（登录页，页面上还没有 handler）");
  for (const [name, k, opts] of [
    ["Ctrl+B（第 1–10 段前缀）", "b", {}],
    ["Ctrl+Y（第 11–20 段前缀）", "y", {}],
    ["Ctrl+M（第 21–25 段前缀）", "m", {}],
    ["Ctrl+Shift+Z（一条龙）", "z", { shift: true }],
  ]) {
    const before = await snapshot();
    await realTap(k, opts);
    await sleep(500);
    const after = await snapshot();
    const d = diff(before, after);
    check(
      `${name} 没有任何浏览器动作`,
      d.fresh.length === 0 && !d.urlChanged && d.heightDelta === 0,
      [
        d.fresh.length ? `新开 ${d.fresh.length} 个页面` : null,
        d.urlChanged ? "地址变了" : null,
        d.heightDelta ? `可视高度 Δ${d.heightDelta}` : null,
      ]
        .filter(Boolean)
        .join("；") || "毫无动静",
    );
    await cleanFresh(d);
  }

  /* ---------- 登录：到有 handler 的页面上测"我们拦了哪些键" ---------- */
  for (let i = 0; i < 60; i += 1) {
    if (await evaluate(`Boolean(document.querySelector('input'))`)) break;
    await sleep(250);
  }
  await evaluate(`(() => {
    const inputs = [...document.querySelectorAll('input')];
    const setValue = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, v);
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
  check("登录成功并进入平台页面（下面测的是「有 handler」的那一半）", inApp, `hash=${await evaluate(`location.hash`)}`);
  if (!inApp) throw new Error("登录没进平台，后面的判定没有意义");
  note("Ctrl+N 这类浏览器**保留键**页面拦不住，所以键位只能避开它 —— 已由单测的名单钉住");

  /* ---------- 乙：合成事件 + preventDefault 审计，测"我们拦了哪些键" ---------- */
  section("乙 · 页面内：我们的 handler 拦了哪些键（合成事件一定送得到页面，不看系统焦点）");
  /*
    审计器：把 `Event.prototype.preventDefault` 包一层 —— 任何 listener（包括我们的 handler）
    只要调过就记一笔，不依赖监听器注册顺序与相（比读 `defaultPrevented` 稳）。
  */
  await evaluate(`(() => {
    window.__prevented = [];
    const orig = Event.prototype.preventDefault;
    Event.prototype.preventDefault = function () {
      try { window.__prevented.push({ type: this.type, key: this.key || "" }); } catch (e) {}
      return orig.apply(this, arguments);
    };
    return true;
  })()`);
  const preventedKeys = async () => {
    const list = await evaluate(`window.__prevented.splice(0, window.__prevented.length)`);
    return (list ?? []).filter((e) => e.type === "keydown").map((e) => String(e.key).toLowerCase());
  };
  /** 合成按键：`window.dispatchEvent(new KeyboardEvent(...))`（与 `验收-快捷键气泡.mjs` 同一套） */
  const synthTap = async (k, { ctrl = true, shift = false } = {}) =>
    evaluate(`(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: ${JSON.stringify(shift ? k.toUpperCase() : k)},
        code: 'Key' + ${JSON.stringify(k.toUpperCase())},
        ctrlKey: ${ctrl}, shiftKey: ${shift}, bubbles: true, cancelable: true,
      }));
      return true;
    })()`);

  const mustPrevent = [
    { name: "Ctrl+B（第 1–10 段前缀）", taps: [["b"]], want: ["b"] },
    { name: "Ctrl+Y（第 11–20 段前缀）", taps: [["y"]], want: ["y"] },
    { name: "Ctrl+M（第 21–25 段前缀）", taps: [["m"]], want: ["m"] },
    { name: "Ctrl+B+1（第①轮）", taps: [["b"], ["1"]], want: ["b", "1"] },
    { name: "Ctrl+Y+3（第⑬轮）", taps: [["y"], ["3"]], want: ["y", "3"] },
    { name: "Ctrl+M+5（第㉕轮）", taps: [["m"], ["5"]], want: ["m", "5"] },
    { name: "Ctrl+Shift+Z（一条龙：按一下走一条）", taps: [["z", { shift: true }]], want: ["z"] },
  ];
  for (const subject of mustPrevent) {
    await preventedKeys();
    for (const [k, opts] of subject.taps) await synthTap(k, opts);
    await sleep(120);
    const keys = await preventedKeys();
    const missed = subject.want.filter((k) => !keys.includes(k));
    check(
      `${subject.name} 被我们拦下`,
      missed.length === 0,
      missed.length ? `没拦下 ${missed.join("/")}（实际拦了 ${keys.join("+") || "（无）"}）` : `拦下 ${keys.join("+")}`,
    );
  }

  section("乙 · 不误伤：浏览器自己的组合必须原样放行（我们不许调 preventDefault）");
  const mustPass = [
    { name: "Ctrl+Shift+B（书签栏开关）", key: "b", shift: true },
    { name: "Ctrl+Shift+Y", key: "y", shift: true },
    { name: "Ctrl+Shift+M", key: "m", shift: true },
    { name: "Ctrl+1（前面没有段前缀，就是切标签页）", key: "1", shift: false },
  ];
  for (const case_ of mustPass) {
    await preventedKeys();
    await synthTap(case_.key, { shift: case_.shift });
    await sleep(120);
    const keys = await preventedKeys();
    check(
      `${case_.name} 不被我们抢`,
      !keys.includes(case_.key),
      keys.length ? `我们拦下了 ${keys.join("/")}` : "我们没拦（浏览器自己处理）",
    );
  }

  console.log(failed ? `\n有 ${failed} 条没过` : "\n全部通过");
  if (failed) process.exitCode = 1;
} finally {
  try {
    chrome.kill();
  } catch {
    /* 已经退了 */
  }
}
