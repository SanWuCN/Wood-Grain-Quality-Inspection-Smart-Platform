/**
 * 工单档案 · 环境读数「Enter 依次填入」端到端验收（真浏览器、真服务端）
 *
 * ── 用户口径（2026-09-28）────────────────────────────────────────
 * 「平台工单档案的录入数据，做个预设，我点开按按回车就会依次填入，数据不穿帮」。
 *
 * 判据（每条都能证伪，尤其是"一次只填一项"与"数据不穿帮"两条）：
 *   ① 打开「录入环境读数」弹窗时六项**全空** —— 预设不是新单默认值（A09 原样不动）；
 *   ② 焦点在输入框上按 Enter，**每按一次只多填一项**，顺序 = 四项读数 → 位置 → 时间；
 *   ③ 六项值与 PRD-工单指派与扫描仪下发-v1.0 §9.2 示例包字段逐字一致
 *      （26.4 / 78 / 1.2 / 1008.6 / 示例寺院内四根木柱检测区域 / 现场墙钟分钟）；
 *   ④ 第 7 次 Enter 不再改动任何一项，弹窗也不自动保存（提词器不越权提交）；
 *   ⑤ 保存草稿后**按 id 查回服务端**，存的就是这几个值（页面好看不算数）；
 *   ⑥ 运行校验全绿：没有一条 is-bad，并生成 CFG- 配置版本 —— 这就是"数据不穿帮"
 *      的硬判据（值不合量程、时间跑到未来、气压把 kPa 当 hPa 存，这里立刻红）。
 *
 * 账号与前置动作照现场动线走：**史**建单并录数据（环境录入 + 运行校验都在其权限内），
 * **沈**（项目经理）指派负责人 —— 服务端对「运行校验」有硬前置：没指派就回 422
 * `NOT_ASSIGNED`，脚本不绕过去，也不自己伪造通过。
 *
 * 前置：8000 在跑（或 vite dev 5173 在跑）。用法：
 *   node tools/验收-环境录入预设.mjs [--url http://127.0.0.1:8000/]
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";

const args = process.argv.slice(2);
const urlIndex = args.indexOf("--url");
const BASE = (urlIndex >= 0 ? args[urlIndex + 1] : "http://127.0.0.1:8000/").replace(/\/$/, "");
const PORT = 9519;
const PROFILE = `${process.env.TEMP}\\mumai-env-preset-profile`;
const SHOT_DIR = process.env.MUMAI_SHOT_DIR ?? "D:\\平台\\验收截图";

/* PRD §9.2 示例包字段：这里再写一遍，改一个字就该红 */
const EXPECTED = {
  airTempC: "26.4",
  relativeHumidityPct: "78",
  windSpeedMs: "1.2",
  pressure: "1008.6",
  unit: "hPa",
  position: "示例寺院内四根木柱检测区域",
};
/** 填入顺序（与弹窗字段顺序一致），第二列是给人看的说明 */
const ORDER = [
  ["airTempC", "温度"],
  ["relativeHumidityPct", "相对湿度"],
  ["windSpeedMs", "风速"],
  ["pressure", "大气压"],
  ["position", "测量位置"],
  ["measuredAt", "测量时间"],
];

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

let orderId = "";
/** 清场动作：在页面里带着登录态删（脚本直连服务端没有令牌，路由会回 401） */
let cleanup = null;
try {
  /* ---------- 连页面 ---------- */
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
      throw new Error(`页面内抛错：${r.result.exceptionDetails.text ?? ""}`);
    }
    return r.result?.result?.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.bringToFront");

  /** 存一张现场图，便于人复核版面 */
  const shot = async (name) => {
    try {
      mkdirSync(SHOT_DIR, { recursive: true });
      const r = await send("Page.captureScreenshot", { format: "png" });
      const data = r?.result?.data;
      if (!data) return null;
      const file = `${SHOT_DIR}\\${name}.png`;
      const { writeFileSync } = await import("node:fs");
      writeFileSync(file, Buffer.from(data, "base64"));
      return file;
    } catch {
      return null;
    }
  };

  /* ---------- 登录（shi）---------- */
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
  check("登录成功并进入平台页面（shi）", inApp, `hash=${await evaluate(`location.hash`)}`);
  if (!inApp) throw new Error("没进平台，后面的判定没有意义");

  /* 清场：跑完把这张临时工单删掉（页面登录态 + DELETE 接口） */
  cleanup = async (id) =>
    evaluate(`(async () => {
      const r = await fetch('/api/work-orders/${id}', {
        method: 'DELETE',
        headers: { authorization: 'Bearer ' + localStorage.getItem('mumai.token') },
      });
      return r.status;
    })()`);

  /* ---------- 建一张新工单（页面自己的登录态，等价于点小木接单）---------- */
  const created = await evaluate(`(async () => {
    const r = await fetch('/api/work-orders/trigger', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + localStorage.getItem('mumai.token') },
      body: JSON.stringify({ eventId: 'envpreset-' + Date.now().toString(36) }),
    });
    const json = await r.json().catch(() => null);
    return { status: r.status, orderId: json && json.orderId, orderNo: json && json.orderNo };
  })()`);
  orderId = created?.orderId ?? "";
  check("建单成功（新工单，环境读数为空）", created?.status === 200 && Boolean(orderId), `${created?.orderNo ?? ""} HTTP ${created?.status}`);
  if (!orderId) throw new Error("没建出工单，后面的判定没有意义");

  /*
    先指派负责人再往下走：录环境读数**不**要求指派（`canEditEnvironment` 只看 `env:entry`），
    但「运行校验」会回 422 `NOT_ASSIGNED`「工单还没有指派负责人，不能生成配置版本」——
    这是服务端的硬前置，验收脚本不能绕过去自己造假通过（第一版就漏了这一步，
    第 ⑥ 组判据因此全红）。
    指派权只在项目经理手里（`canAssign = manager && …`），所以这一步用沈的令牌，
    与现场动线一致：小木接单 → 沈指派 → 史录数据并校验。
  */
  const assigned = await evaluate(`(async () => {
    const login = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'shen', password: '123456' }),
    });
    const shen = (await login.json()).token;
    const r = await fetch('/api/work-orders/${orderId}/assignment', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + shen },
      body: JSON.stringify({ leaderAccountId: 'shi', members: [{ accountId: 'rao', duties: ['environment_entry'] }], note: '环境录入预设验收' }),
    });
    const json = await r.json().catch(() => null);
    return { status: r.status, leader: json && json.assignment ? json.assignment.leaderLabel : null };
  })()`);
  check("沈（项目经理）指派负责人 → 史（校验的硬前置）", assigned?.status === 200, `HTTP ${assigned?.status}　负责人=${assigned?.leader ?? "?"}`);

  /* ---------- 进工单档案页并等环境面板就绪 ---------- */
  await evaluate(`location.hash = '#/orders?order=${orderId}'`);
  let panelReady = false;
  for (let i = 0; i < 80; i += 1) {
    panelReady = await evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '录入读数');
      return Boolean(document.querySelector('.wo-readings') && btn && !btn.disabled);
    })()`);
    if (panelReady) break;
    await sleep(250);
  }
  check("工单档案页出现可用的「录入读数」（本单环境录入权限为真）", panelReady);
  if (!panelReady) throw new Error("环境面板没就绪，后面的判定没有意义");

  /* ---------- 打开弹窗，先看它是不是空的 ---------- */
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '录入读数');
    if (btn) btn.click();
    return Boolean(btn);
  })()`);

  /**
   * 读弹窗六项 + 单位。全部按 `aria-label` 取值：改版面、改列宽都不影响判据，
   * 只有"值本身"能让它变。
   */
  const readForm = () => evaluate(`(() => {
    const val = (label) => {
      const el = document.querySelector('.modal [aria-label="' + label + '"]');
      return el ? String(el.value) : null;
    };
    return {
      open: Boolean(document.querySelector('.modal')),
      airTempC: val('温度读数'),
      relativeHumidityPct: val('相对湿度读数'),
      windSpeedMs: val('风速读数'),
      pressure: val('大气压读数'),
      unit: val('大气压单位'),
      position: val('测量位置'),
      measuredAt: val('测量时间'),
    };
  })()`);

  let form = null;
  for (let i = 0; i < 40; i += 1) {
    form = await readForm();
    if (form?.open && form.airTempC !== null) break;
    await sleep(200);
  }
  check("① 弹窗打开：六项都空（没有 26.4 / 78 / 1.2，也没有 1013.25）", Boolean(
    form?.open &&
      ["airTempC", "relativeHumidityPct", "windSpeedMs", "pressure", "position", "measuredAt"].every((k) => form[k] === ""),
  ), `温度=${JSON.stringify(form?.airTempC)} 湿度=${JSON.stringify(form?.relativeHumidityPct)} 风速=${JSON.stringify(form?.windSpeedMs)} 气压=${JSON.stringify(form?.pressure)} 位置=${JSON.stringify(form?.position)} 时间=${JSON.stringify(form?.measuredAt)}`);
  check("① 气压单位默认 hPa（预设值与单位绑定）", form?.unit === EXPECTED.unit, `unit=${form?.unit}`);

  /* ---------- 焦点放进输入框，然后按 Enter ---------- */
  const focusFirst = () =>
    evaluate(`(() => {
      const el = document.querySelector('.modal [aria-label="温度读数"]');
      if (el) el.focus();
      return document.activeElement === el;
    })()`);
  check("② 焦点落在输入框上（后面的 Enter 都从这里发）", await focusFirst());

  /** 真实输入通道：CDP 会走浏览器的加速键判定，与手按最接近 */
  const tapReal = async () => {
    const base = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await send("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", unmodifiedText: "\r", ...base });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(160);
  };
  /**
   * 退路：合成事件。
   *
   * ⚠ 合成事件永远触发不了**浏览器自己的**加速键（见 `验收-浏览器不吃键位.mjs` 的口径），
   * 但这里要验的是**页面自己的 handler**，合成事件照走 React 的合成系统 —— 所以它能
   * 兜住"CDP 送不进渲染进程"这种情况，只是通道不同，报告里照实标出来。
   */
  const tapSynthetic = () =>
    evaluate(`(() => {
      const el = document.activeElement;
      if (!el) return false;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      return true;
    })()`);

  let channel = "CDP 真实输入";
  await tapReal();
  let snap = await readForm();
  if (snap.airTempC === "") {
    channel = "合成事件（CDP 真实输入在本机送不到渲染进程）";
    await tapSynthetic();
    snap = await readForm();
  }
  const tap = async () => (channel === "CDP 真实输入" ? await tapReal() : await tapSynthetic());

  check(
    `② 第一次 Enter 填了温度（按键通道：${channel}）`,
    snap.airTempC === EXPECTED.airTempC,
    `温度=${JSON.stringify(snap.airTempC)}`,
  );

  /* ---------- 剩下五次：每次只多一项 ---------- */
  for (let step = 1; step < ORDER.length; step += 1) {
    const before = await readForm();
    await tap();
    const after = await readForm();
    const changed = ORDER.map(([key]) => key).filter((key) => before[key] !== after[key]);
    const [wantKey, wantLabel] = ORDER[step];
    check(
      `② 第 ${step + 1} 次 Enter 只填「${wantLabel}」`,
      changed.length === 1 && changed[0] === wantKey,
      `实际变化：${changed.length ? changed.join("、") : "无"}　${wantLabel}=${JSON.stringify(after[wantKey])}`,
    );
  }

  form = await readForm();
  const shotFilled = await shot("环境录入预设-六项填满");

  /* ---------- ③ 值与文档逐字一致 ---------- */
  check("③ 温度 = 26.4 ℃（PRD §9.2）", form.airTempC === EXPECTED.airTempC, `实际 ${JSON.stringify(form.airTempC)}`);
  check("③ 相对湿度 = 78 %RH（PRD §9.2）", form.relativeHumidityPct === EXPECTED.relativeHumidityPct, `实际 ${JSON.stringify(form.relativeHumidityPct)}`);
  check("③ 风速 = 1.2 m/s（PRD §9.2）", form.windSpeedMs === EXPECTED.windSpeedMs, `实际 ${JSON.stringify(form.windSpeedMs)}`);
  check(
    "③ 大气压 = 1008.6 hPa（不是 1013.25）",
    form.pressure === EXPECTED.pressure && form.unit === EXPECTED.unit,
    `实际 ${JSON.stringify(form.pressure)} ${form.unit}`,
  );
  check("③ 测量位置 = 示例寺院内四根木柱检测区域", form.position === EXPECTED.position, `实际 ${JSON.stringify(form.position)}`);
  check("③ 测量时间 = 现场墙钟的分钟（YYYY-MM-DDTHH:mm，不晚于现在）", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(form.measuredAt)) && new Date(String(form.measuredAt)).getTime() <= Date.now() + 1000, `实际 ${JSON.stringify(form.measuredAt)}`);

  /* ---------- ④ 第七次 Enter 无事发生 ---------- */
  const before7 = await readForm();
  await tap();
  const after7 = await readForm();
  check(
    "④ 第 7 次 Enter 不再改动任何一项，弹窗也不自动保存",
    after7.open === true &&
      ["airTempC", "relativeHumidityPct", "windSpeedMs", "pressure", "position", "measuredAt"].every((k) => before7[k] === after7[k]),
    `弹窗仍打开=${after7.open}`,
  );

  /* ---------- ⑤ 保存草稿 ---------- */
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.modal button')].find((el) => el.textContent.trim() === '保存草稿');
    if (btn) btn.click();
    return Boolean(btn);
  })()`);
  let saved = false;
  for (let i = 0; i < 60; i += 1) {
    saved = await evaluate(`!document.querySelector('.modal')`);
    if (saved) break;
    await sleep(250);
  }
  check("⑤ 保存草稿后弹窗关闭（服务端接受）", saved);

  /* 服务端复核：按 id 查回来，页面好看不算数 */
  const stored = await evaluate(`(async () => {
    const r = await fetch('/api/work-orders/${orderId}', { headers: { authorization: 'Bearer ' + localStorage.getItem('mumai.token') } });
    const json = await r.json();
    const env = json && json.environment;
    return env ? {
      inputs: env.inputs, pressureInput: env.pressureInput, position: env.position,
      measuredAt: env.measuredAt, draftRevision: env.draftRevision, updatedByLabel: env.updatedByLabel,
    } : null;
  })()`);
  check(
    "⑤ 服务端存的就是六项：26.4 / 78 / 1.2 + 气压 1008.6 hPa + 位置 + 测量时间",
    Number(stored?.inputs?.airTempC) === 26.4 &&
      Number(stored?.inputs?.relativeHumidityPct) === 78 &&
      Number(stored?.inputs?.windSpeedMs) === 1.2 &&
      Number(stored?.inputs?.atmosphericPressureHpa) === 1008.6 &&
      stored?.pressureInput?.value === 1008.6 &&
      String(stored?.pressureInput?.unit ?? "").toLowerCase() === "hpa" &&
      stored?.position === EXPECTED.position &&
      Boolean(stored?.measuredAt),
    `inputs=${JSON.stringify(stored?.inputs)} pressureInput=${JSON.stringify(stored?.pressureInput)} rev=${stored?.draftRevision} 录入人=${stored?.updatedByLabel}`,
  );

  /* ---------- ⑥ 运行校验全绿 ---------- */
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '运行校验');
    if (btn) btn.click();
    return Boolean(btn);
  })()`);
  let checks = null;
  let validateError = "";
  for (let i = 0; i < 80; i += 1) {
    checks = await evaluate(`(() => {
      const items = [...document.querySelectorAll('.wo-checks li')];
      const version = document.body.textContent.match(/CFG-[A-Z0-9-]+/);
      const err = document.querySelector('.wop-error');
      return {
        total: items.length,
        bad: items.filter((li) => li.classList.contains('is-bad')).length,
        version: version ? version[0] : null,
        error: err ? err.textContent.trim().slice(0, 120) : null,
      };
    })()`);
    if (checks?.error) validateError = checks.error;
    if (checks && checks.total > 0) break;
    await sleep(250);
  }
  /* 截图前把校验结论滚进视野：不然截到的是页面顶部，人复核时看不到那十几条绿勾 */
  await evaluate(`(() => {
    const el = document.querySelector('.wo-checks');
    if (el) el.scrollIntoView({ block: 'center' });
    return Boolean(el);
  })()`);
  await sleep(300);
  const shotValidated = await shot("环境录入预设-校验通过");
  check(
    "⑥ 运行校验全绿（一条 is-bad 都没有）",
    Boolean(checks && checks.total > 0 && checks.bad === 0),
    checks?.total ? `校验项 ${checks.total} 条，判红 ${checks.bad} 条` : `没有校验结论${validateError ? `　页面报错：${validateError}` : ""}`,
  );
  check("⑥ 生成了配置版本（CFG-…）", Boolean(checks?.version), `版本 ${checks?.version ?? "未找到"}`);

  /* 服务端复核校验结论：页面上没有红字，服务端也得是 ok */
  const config = await evaluate(`(async () => {
    const r = await fetch('/api/work-orders/${orderId}', { headers: { authorization: 'Bearer ' + localStorage.getItem('mumai.token') } });
    const json = await r.json();
    const cfg = json && json.environment && json.environment.config;
    return cfg ? { configVersion: cfg.configVersion, bad: cfg.checks.filter((c) => !c.ok).map((c) => c.label), method: cfg.methodVersion } : null;
  })()`);
  check(
    "⑥ 服务端配置版本里的判据也全部通过",
    Boolean(config && config.bad.length === 0),
    `${config?.configVersion ?? "无版本"}　方法 ${config?.method ?? "?"}　未通过 ${JSON.stringify(config?.bad ?? [])}`,
  );

  if (shotFilled) console.log(`\n  截图：${shotFilled}`);
  if (shotValidated) console.log(`  截图：${shotValidated}`);
} finally {
  if (orderId && cleanup) {
    const status = await cleanup(orderId).catch(() => null);
    console.log(`\n  清理临时工单：HTTP ${status ?? "失败"}`);
    if (!(status >= 200 && status < 300)) failed += 1;
  }
  chrome.kill();
}

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项未通过`}`);
process.exit(failed === 0 ? 0 : 1);
