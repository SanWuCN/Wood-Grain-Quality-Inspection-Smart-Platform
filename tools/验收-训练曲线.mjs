/**
 * 训练曲线（固件及模型 → 训练验证 → 训练曲线）· 端到端验收（真浏览器、真数据）
 *
 * ── 为什么单独验这一页 ────────────────────────────────────────────
 * 原先这张图是手画 SVG：**没有纵轴刻度**、横轴只有首末两个数、鼠标放上去读不到任何值、
 * 图例不带当前值 —— 评审看它没法回答「第几轮降到多少、哪一轮开始不降了」。
 * 现在换成平台既有的 ECharts（与总览页同一套 `CHART_BASE`），并补上一排**现算**口径。
 *
 * 判据（每条都能证伪）：
 *   ① ECharts 真的画出来了（canvas 有实际宽高，不是 0×0 的空白）；
 *   ② 四个口径的数与种子里的曲线逐位对得上（训练损失 0.2062 / 验证损失 0.3000 /
 *      最低 0.2928@24 轮 / 比基线低 0.1230）；
 *   ③ 鼠标移到图上能读出**每一条线在该轮的值**（Tooltip 落在 DOM 上，读它的文字）；
 *   ④ 早停与曲线对账：第 30 轮停止、距最低点 6 轮，与配置声明的 patience 一致；
 *   ⑤ 曲线、执行节点占用、控制台共用同一 epoch 轴（页面自己写明来源）。
 *
 * 前置：8000 在跑。用法：node tools/验收-训练曲线.mjs [--url http://127.0.0.1:8000/]
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const urlIndex = args.indexOf("--url");
const BASE = (urlIndex >= 0 ? args[urlIndex + 1] : "http://127.0.0.1:8000/").replace(/\/$/, "");
const PORT = 9515;
const PROFILE = `${process.env.TEMP}\\mumai-loss-curve-profile`;
const SHOT_DIR = process.env.MUMAI_SHOT_DIR ?? "D:\\平台\\验收截图";

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
    "--window-size=1600,1100",
    "--mute-audio",
    `${BASE}/#/`,
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `　（${detail}）` : ""}`);
  if (!ok) failed += 1;
};

try {
  let page = null;
  for (let i = 0; i < 120; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl && t.url.startsWith(BASE));
      if (page) break;
    } catch {
      /* 还没起来 */
    }
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
    if (r.result?.exceptionDetails) {
      throw new Error(`页面内抛错：${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`);
    }
    return r.result?.result?.value;
  };
  const shot = async (name) => {
    try {
      mkdirSync(SHOT_DIR, { recursive: true });
      const r = await send("Page.captureScreenshot", { format: "png" });
      const data = r?.result?.data;
      if (!data) return;
      const file = `${SHOT_DIR}\\${name}.png`;
      writeFileSync(file, Buffer.from(data, "base64"));
      console.log(`  · 现场截图：${file}`);
    } catch {
      /* 截图失败不影响结论 */
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");

  /* ---------- 登录 ---------- */
  for (let i = 0; i < 80; i += 1) {
    if (await evaluate(`Boolean(document.querySelector('input'))`)) break;
    await sleep(250);
  }
  await evaluate(`(() => {
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
  for (let i = 0; i < 80; i += 1) {
    const st = await evaluate(`({ hash: location.hash, nav: document.querySelectorAll('nav button, nav a, aside button').length })`);
    if (st && !String(st.hash).includes("login") && st.nav > 0) {
      inApp = true;
      break;
    }
    await sleep(250);
  }
  check("登录成功并进入平台页面", inApp, `hash=${await evaluate(`location.hash`)}`);

  /* ---------- 固件及模型 → 训练验证 → 训练曲线 ---------- */
  await evaluate(`location.hash = '#/firmware?tab=training&view=curve'`);
  let ready = false;
  for (let i = 0; i < 80; i += 1) {
    ready = await evaluate(`Boolean(document.querySelector('.tw-chart canvas') && document.querySelectorAll('.tw-kpi li').length === 4)`);
    if (ready) break;
    await sleep(250);
  }
  check("训练验证页的「训练曲线」视图渲染出 ECharts 画布与四个口径", ready, ready ? "canvas + 4 项就位" : "没等到 .tw-chart canvas");
  if (!ready) throw new Error("曲线没渲染，后续检查没有意义");
  await sleep(600);

  /* ---------- ① canvas 真的画出来了 ---------- */
  const canvas = await evaluate(`(() => {
    const el = document.querySelector('.tw-chart canvas');
    const box = el.getBoundingClientRect();
    const ctx = el.getContext('2d');
    /* 采样画布像素：全是透明说明其实什么都没画（0×0 或没 setOption） */
    const data = ctx.getImageData(0, 0, el.width, el.height).data;
    let painted = 0;
    for (let i = 3; i < data.length; i += 4 * 37) if (data[i] > 0) painted += 1;
    return { w: Math.round(box.width), h: Math.round(box.height), painted, ratio: el.width / Math.max(1, el.height) };
  })()`);
  check("ECharts 画布有实际尺寸且真的画上了内容", canvas.w > 400 && canvas.h > 200 && canvas.painted > 0, `${canvas.w}×${canvas.h}，采样到 ${canvas.painted} 个不透明像素`);

  /* ---------- ② 四个口径的数与曲线逐位对得上 ---------- */
  const kpi = await evaluate(`(() => [...document.querySelectorAll('.tw-kpi li')].map((li) => ({
    key: li.querySelector('small')?.textContent.trim() ?? '',
    value: li.querySelector('b')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    /* 直接子 span：NumberAnimation 自己也是 span，不加 ':scope >' 会把 <b> 里的数字读成说明 */
    note: li.querySelector(':scope > span')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    tone: li.className,
  })))()`);
  const byKey = (key) => kpi.find((item) => item.key.includes(key)) ?? { value: "", note: "", tone: "" };
  check("当前训练损失 = 0.2062（曲线末值，界面现算）", byKey("训练损失").value === "0.2062", `${byKey("训练损失").value} · ${byKey("训练损失").note}`);
  check("当前验证损失 = 0.3000，最低 0.2928 在第 24 轮", byKey("验证损失").value === "0.3000" && /最低 0.2928（第 24 轮）/.test(byKey("验证损失").note), `${byKey("验证损失").value} · ${byKey("验证损失").note}`);
  check("与基线对照 = 0.1230（基线末值 0.4230 − 候选 0.3000）", byKey("与基线对照").value === "0.1230" && byKey("与基线对照").tone.includes("is-ok"), `${byKey("与基线对照").value} · ${byKey("与基线对照").note}`);
  check(
    "早停规则与曲线对账：第 30 轮停止 · 距最低点 6 轮 · 规则判定为一致",
    /连续 6 轮不下降即停止/.test(byKey("早停规则").value) && /第 30 轮停止 · 距最低点（第 24 轮）6 轮，与规则一致/.test(byKey("早停规则").note) && byKey("早停规则").tone.includes("is-ok"),
    `${byKey("早停规则").value} · ${byKey("早停规则").note}`,
  );

  /* ---------- ③ 鼠标移上去能读出每条线的值 ---------- */
  /* 图在首屏之外时，鼠标事件的视口坐标会落到别的元素上 —— 先滚进视口再取矩形 */
  await evaluate(`document.querySelector('.tw-chart')?.scrollIntoView({ block: 'center' })`);
  await sleep(500);
  const box = await evaluate(`(() => { const b = document.querySelector('.tw-chart canvas').getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
  /*
    用 CDP 真实输入通道移鼠标（合成事件 ECharts 不一定认）：在网格里扫几个位置，
    每次移完都轮询一下 Tooltip —— 单点移一次会撞上"页面还没停稳"而读空（实测三次里两次）。
  */
  const readTip = () =>
    evaluate(`(() => {
      const el = document.querySelector('.tw-chart__tip');
      const host = document.querySelector('.tw-chart');
      const kids = [...(host?.children ?? [])].map((node) => node.tagName.toLowerCase() + '.' + (node.className || ''));
      return { text: el ? el.textContent.replace(/\\s+/g, ' ').trim() : null, kids };
    })()`);

  let tip = { text: null, kids: [] };
  for (const ratio of [0.5, 0.7, 0.3, 0.85, 0.6]) {
    /*
      先在被测元素上直接派发 mousemove（zrender 就是按 clientX/clientY 算偏移的），
      再用 CDP 真实鼠标扫一遍兜底：无头环境里真实鼠标事件偶尔落在别的元素上，
      两条路一起走才稳（实测只走 CDP 时三次里两次读空）。
    */
    await evaluate(`(() => {
      const canvas = document.querySelector('.tw-chart canvas');
      if (!canvas) return false;
      const r = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new MouseEvent('mousemove', {
        clientX: r.left + r.width * ${ratio},
        clientY: r.top + r.height * 0.5,
        bubbles: true,
      }));
      return true;
    })()`);
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(box.x + box.w * ratio),
      y: Math.round(box.y + box.h * 0.5),
      buttons: 0,
    });
    for (let i = 0; i < 8; i += 1) {
      tip = await readTip();
      if (tip.text) break;
      await sleep(200);
    }
    if (tip.text) break;
  }

  /* 真读不到时把"这一点上盖的是谁"打出来，别让人对着"没弹"猜 */
  const blocker = tip.text
    ? null
    : await evaluate(`(() => {
        const el = document.elementFromPoint(${Math.round(box.x + box.w * 0.5)}, ${Math.round(box.y + box.h * 0.5)});
        return el ? el.tagName.toLowerCase() + '.' + (el.className || '') : 'null';
      })()`);
  check(
    "鼠标移到图上弹出 Tooltip（不是一张哑图）",
    typeof tip?.text === "string" && tip.text.length > 0,
    tip?.text ?? `没有 .tw-chart__tip；容器子节点：${tip?.kids.join(" / ") || "无"}；该点上是 ${blocker ?? "null"}`,
  );
  check(
    "Tooltip 里同时给出轮次与三条线的值（第几轮降到多少，一眼读得出）",
    Boolean(tip?.text) &&
      /第 \d+ 轮/.test(tip.text) &&
      /训练损失 \d\.\d{3}/.test(tip.text) &&
      /验证损失 \d\.\d{3}/.test(tip.text) &&
      /基线验证损失 \d\.\d{3}/.test(tip.text),
    tip?.text ?? "—",
  );

  await shot("训练曲线");

  /* ---------- ⑤ 口径与来源 ---------- */
  const note = await evaluate(`(() => {
    const panel = document.querySelector('.tw-chart')?.closest('.tech-panel');
    return panel?.querySelector('p.note')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
  })()`);
  check("图下写明数据来源与同一 epoch 轴（epochs.csv / 归档实验包）", /epochs\.csv/.test(note) && /同一 epoch 轴|同一个 epoch/.test(note), note.slice(0, 120));

  /* ---------- 失败案例：同一张图读得出过拟合 ---------- */
  await evaluate(`(() => {
    const label = [...document.querySelectorAll('.fw-training__switch')].pop();
    const input = label?.querySelector('input');
    if (input) input.click();
    return Boolean(input);
  })()`);
  let failedCase = null;
  for (let i = 0; i < 60; i += 1) {
    failedCase = await evaluate(`(() => {
      const panel = document.querySelector('.tw-chart')?.closest('.tech-panel');
      const chip = [...(panel?.querySelectorAll('.chip') ?? [])].map((el) => el.textContent.replace(/\\s+/g, ' ').trim())
        .find((text) => text.includes('抬升')) ?? '';
      const warn = [...document.querySelectorAll('.tw-kpi li')].filter((li) => li.className.includes('is-warn'))
        .map((li) => li.querySelector('small')?.textContent.trim() ?? '').join(' / ');
      const note = panel?.querySelector('p.note')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
      return { chip, warn, note };
    })()`);
    /* 轮询到"与曲线一致的那一条"为止：切换案例时会先渲染出上一帧的旧提示 */
    if (/第 24 轮起抬升/.test(failedCase?.chip ?? "")) break;
    await sleep(250);
  }
  check(
    "切到失败案例：发散点轮次与曲线一致（第 24 轮起抬升）",
    /第 24 轮起抬升/.test(failedCase?.chip ?? ""),
    failedCase?.chip ?? "没有出现发散提示",
  );
  check(
    "失败案例里验证损失那一格转为告警色，图下写明回升幅度",
    /当前验证损失/.test(failedCase?.warn ?? "") && /验证损失自第 24 轮起回升 0\.066/.test(failedCase?.note ?? ""),
    `${failedCase?.warn} · ${(failedCase?.note ?? "").slice(0, 90)}`,
  );
  await shot("训练曲线-失败案例");
} catch (error) {
  console.error(`  ✗ 工装自身出错：${error?.message ?? error}`);
  failed += 1;
} finally {
  chrome.kill();
}

console.log(failed === 0 ? "\n全部通过（训练验证 · 训练曲线）" : `\n${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
