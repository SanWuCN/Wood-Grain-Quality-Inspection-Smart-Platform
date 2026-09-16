/**
 * 隐藏快捷键 Ctrl + Q + L 的界面级验收（PRD-工单指派与扫描仪下发-v1.0 A01 / A02）
 *
 * 契约测试（`tools/test-work-orders.mjs`）验的是服务端幂等与主体编号；
 * 这里验的是**按键这件事本身**：真的往浏览器里按 Ctrl、Q、L，看页面有没有建单、
 * 有没有通知、有没有把快捷键写到界面上。
 *
 * 用法：
 *   node tools/test-order-shortcut.mjs                     # 打 http://localhost:5173/#/orders
 *   node tools/test-order-shortcut.mjs --url http://localhost:8000/#/orders
 *   BASE 地址也可以指向构建产物（`npm run build` 后用 server/index.mjs --static dist 起的那个）
 *
 * 退出码：全部通过 0，有断言失败 1。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function findChrome() {
  const override = process.env.CHROME_PATH;
  if (override && existsSync(override)) return override;
  const candidates = [
    /* macOS */
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    /* Linux */
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    /* Windows（原脚本只有 macOS/Linux 路径，Windows 上一跑就抛
       "未找到 Chrome / Chromium"；补上这三个后无需再设 CHROME_PATH。
       位置来自 Chrome/Edge 的默认安装路径，用户级安装走 LOCALAPPDATA 那条） */
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    `${process.env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  const hit = candidates.find((path) => existsSync(path));
  if (!hit) throw new Error(`未找到 Chrome / Chromium，可用 CHROME_PATH 指定。已尝试：\n  ${candidates.join("\n  ")}`);
  return hit;
}

const url = arg("url", "http://localhost:5173/#/orders");
const failures = [];
const notes = [];
const check = (ok, label, detail = "") => {
  if (ok) {
    console.log(`  ✓ ${label}`);
    return true;
  }
  failures.push(`${label}${detail ? ` —— ${detail}` : ""}`);
  console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ""}`);
  return false;
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const port = 9800 + Math.floor(Math.random() * 500);
const profile = resolve("tmp-shot", `profile-keys-${port}`);
mkdirSync(profile, { recursive: true });
const chrome = spawn(
  findChrome(),
  [
    "--headless=new",
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
    "--disable-gpu-sandbox",
    "--no-sandbox",
    "--no-first-run",
    "--disable-extensions",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--window-size=1440,900",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function endpoint() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return (await response.json()).webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error("Chrome 调试端口没起来");
}

const ws = new WebSocket(await endpoint());
await new Promise((done, fail) => {
  ws.onopen = done;
  ws.onerror = fail;
});

let seq = 0;
const pending = new Map();
const consoleErrors = [];
let sessionId = null;

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve: done, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(JSON.stringify(message.error))) : done(message.result);
    return;
  }
  if (message.method === "Runtime.exceptionThrown") {
    consoleErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    consoleErrors.push(message.params.args.map((item) => item.value ?? item.description).join(" "));
  }
};

function send(method, params = {}, useSession = true) {
  const id = ++seq;
  const payload = { id, method, params };
  if (useSession && sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((done, fail) => pending.set(id, { resolve: done, reject: fail }));
}

const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "页面脚本抛错");
  return result.result.value;
};

/** 真按键：按下修饰键 → Q → L，再全部释放（Ctrl 全程按住） */
async function pressSequence({ withControl = true, letters = ["q", "l"] } = {}) {
  const modifiers = withControl ? 2 : 0;
  const codes = { q: { code: "KeyQ", vk: 81 }, l: { code: "KeyL", vk: 76 } };
  if (withControl) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers });
  }
  for (const letter of letters) {
    const info = codes[letter];
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: letter,
      code: info.code,
      windowsVirtualKeyCode: info.vk,
      modifiers,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: letter,
      code: info.code,
      windowsVirtualKeyCode: info.vk,
      modifiers,
    });
    await sleep(60);
  }
  if (withControl) {
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 });
  }
}

const { targetId } = await send("Target.createTarget", { url: "about:blank" }, false);
const attached = await send("Target.attachToTarget", { targetId, flatten: true }, false);
sessionId = attached.sessionId;
await send("Runtime.enable");
await send("Page.enable");
await send(
  "Page.addScriptToEvaluateOnNewDocument",
  {
    source: `localStorage.setItem('mumai.session', JSON.stringify({accountId:'shen',login:'shen',at:new Date().toISOString()}));`,
  },
);

console.log(`\n快捷键验收：${url}\n`);
await send("Page.navigate", { url });
/** 等外壳与工单列表挂上：构建产物首屏要加载地图与字体，固定 sleep 容易假失败 */
for (let attempt = 0; attempt < 40; attempt += 1) {
  await sleep(500);
  const ready = await evaluate("Boolean(document.querySelector('.orders-side .order-item, .orders-side .state-block'))");
  if (ready) break;
}
await sleep(1500);

try {
  /* ---- A01：界面上没有来单入口，也没有快捷键说明 ---- */
  const bodyText = await evaluate("document.body.innerText");
  check(!/Ctrl\s*\+\s*Q/i.test(bodyText), "A01：界面上不出现快捷键说明");
  check(!/来单|收件箱/.test(bodyText), "A01：界面上没有「来单 / 收件箱」入口");

  /*
    等列表数字稳定再取基准：页面首屏会先渲染一次空/旧列表，登录完成与 300ms 防抖
    各触发一次刷新，读早了会把「刷新把已有单补齐」误当成「刚建了一单」。
  */
  const countOrders = () =>
    evaluate("Number((document.querySelector('.orders-side .tech-panel__extra')?.textContent ?? '0').replace(/\\D/g, '')) || 0");
  let beforeCount = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const first = await countOrders();
    await sleep(700);
    const second = await countOrders();
    if (first === second && second > 0) {
      beforeCount = second;
      break;
    }
    beforeCount = second;
  }

  /* ---- A01：Ctrl + Q + L 建单 ---- */
  await pressSequence();
  await sleep(2500);
  const toastText = await evaluate("document.querySelector('.appshell__toasts')?.innerText ?? ''");
  check(/收到新工单\s*WO-\d{8}-\d{4}/.test(toastText), "A01：出现「收到新工单 WO-……」通知", toastText.trim());
  check(/查看/.test(toastText), "A01：通知可点击查看（带「查看」动作）");

  const listText = await evaluate("document.querySelector('.orders-side')?.innerText ?? ''");
  check(/WO-\d{8}-\d{4}/.test(listText), "A01：工单列表实时刷新并出现新单");
  const afterCount = await countOrders();
  check(afterCount === beforeCount + 1, "A01：新单只增加一条", `${beforeCount} → ${afterCount}`);

  /* ---- A02：按住不放（repeat）不重复建单 ---- */
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2 });
  for (let repeat = 0; repeat < 6; repeat += 1) {
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "q",
      code: "KeyQ",
      windowsVirtualKeyCode: 81,
      modifiers: 2,
      autoRepeat: true,
    });
  }
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "l", code: "KeyL", windowsVirtualKeyCode: 76, modifiers: 2, autoRepeat: true });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "l", code: "KeyL", windowsVirtualKeyCode: 76, modifiers: 2 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 });
  await sleep(2000);
  const afterRepeat = await countOrders();
  check(afterRepeat === afterCount, "A02：长按 repeat 不重复建单", `${afterCount} → ${afterRepeat}`);

  /* ---- A02：输入框里按同样的序列不触发 ---- */
  await evaluate("document.querySelector('.wop-search')?.focus(); true");
  await pressSequence();
  await sleep(1800);
  const afterTyping = await countOrders();
  check(afterTyping === afterRepeat, "A02：输入框内按键不触发建单", `${afterRepeat} → ${afterTyping}`);
  await evaluate("document.activeElement?.blur(); true");

  /* ---- A02：只按 L（没有 Q）不触发 ---- */
  await pressSequence({ letters: ["l"] });
  await sleep(1500);
  const afterLoneL = await countOrders();
  check(afterLoneL === afterTyping, "A02：单独按 L 不触发", `${afterTyping} → ${afterLoneL}`);

  /* ---- A02：一次完整触发后再完整触发，能建下一单 ---- */
  await pressSequence();
  await sleep(2500);
  const afterSecond = await countOrders();
  check(afterSecond === afterLoneL + 1, "A02：按键全部释放后再次完整触发可建下一单", `${afterLoneL} → ${afterSecond}`);

  /* ---- 令牌失效自愈：服务重启换了签名密钥，旧令牌一律 401 ---- */
  await evaluate("localStorage.setItem('mumai.token', 'stale.invalid.token'); true");
  const beforeStale = await countOrders();
  await pressSequence();
  await sleep(3000);
  const afterStale = await countOrders();
  check(afterStale === beforeStale + 1, "令牌失效后自动重新登录并重放，不弹失败", `${beforeStale} → ${afterStale}`);

  const newOrderNo = await evaluate(
    "(document.querySelector('.orders-side .order-item b')?.textContent ?? '').trim()",
  );
  const detailNo = await evaluate("(document.querySelector('.orders-main .tech-panel__head h3, .orders-main .tech-panel__head h2, .orders-main .tech-panel__head')?.textContent ?? '').trim()");
  check(newOrderNo && detailNo.includes(newOrderNo), "A01：新单被选中并显示详情", `${newOrderNo} / ${detailNo}`);

  const detailText = await evaluate("document.querySelector('.orders-main')?.innerText ?? ''");
  check(/待指派/.test(detailText), "A01：新单初始状态是待指派");
  check(/Z01/.test(detailText) && /Z04/.test(detailText), "A23：详情里出现 Z01—Z04 四条主体");
  /*
    说明文字里会出现「雷达结果」这个词（正是在声明**没有**沿用演示结论），
    所以判据盯的是**数据**：没有雷达响应列、没有 0.87 这类结论数值。
  */
  check(
    !/雷达响应/.test(detailText) && !/0\.\d\d/.test(detailText),
    "A04：新单不灌入演示雷达结论（无响应列、无 0.87 这类数值）",
  );
  check(/—|待录入/.test(detailText), "A09：环境读数显示为空（—/待录入）");
  check(!/全栈接收|返回 ack/.test(detailText), "A14：页面不再出现「全栈接收 / 返回 ack」");

  check(consoleErrors.length === 0, "控制台没有报错", consoleErrors.slice(0, 3).join(" | "));
} finally {
  try {
    ws.close();
  } catch {
    /* 关不掉就算了 */
  }
  chrome.kill();
}

if (notes.length) console.log(`\n记录：\n  - ${notes.join("\n  - ")}`);
if (failures.length) {
  console.error(`\n不达标 ${failures.length} 项：\n  - ${failures.join("\n  - ")}\n`);
  process.exit(1);
}
console.log("\n快捷键验收：全部通过\n");
