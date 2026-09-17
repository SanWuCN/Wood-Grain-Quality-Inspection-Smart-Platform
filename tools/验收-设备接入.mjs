/**
 * 设备接入 · 链路自检 端到端验收（真浏览器 + 真服务端）
 *
 * ── 用户给的交接包（2026-09-22）────────────────────────────────────
 * 「木脉智检-设备接入交接包」的结论：代码是全的，缺的是三份故意不入库的本地配置
 * + 一种正确的启动方式。原包给了 `tools/smoke-devices.sh`（bash，从外面发 HTTP 自检）。
 *
 * ── 这个工装验什么（与"设备链路通不通"是两件事）────────────────────
 * 它验的是**诊断本身靠不靠得住**：
 *   ① 平台内的 `/api/device-readiness` 能跑出 5 节结论（0 平台 / 1 托管 / 2 小车 / 3 终端 / 4 屏幕）；
 *   ② 它与**从外面**按交接包同一套判据算出来的结论**逐条一致**（不能各说一套）；
 *   ③ 硬件详情 → 设备接入页把结论、三份配置的落盘状态、三个坑与验收命令都渲染出来；
 *   ④ 页面上写得清"改哪个文件、要不要重启"（现场照着改就能通）。
 *
 * ⚠ 设备链路本身可能是**没配**的（这台机器就是）：那不算本工装失败 ——
 * 页面的职责是把「为什么看不到小车/扫描仪」如实说清。所以这里断言的是
 * "该 FAIL 的确实报了 FAIL 并给出修法"，而不是"必须全绿"。
 *
 * 用法：node tools/验收-设备接入.mjs [--url http://127.0.0.1:8000/]
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

const args = process.argv.slice(2);
const urlIndex = args.indexOf("--url");
const BASE = (urlIndex >= 0 ? args[urlIndex + 1] : "http://127.0.0.1:8000/").replace(/\/$/, "");
const PORT = 9519;
const PROFILE = `${process.env.TEMP}\\mumai-device-access-profile`;
const SHOT_DIR = process.env.MUMAI_SHOT_DIR ?? "D:\\平台\\验收截图";
const DEVICE_ID = "handheld-02";

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `　（${detail}）` : ""}`);
  if (!ok) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 第一部分：从外面自检（交接包 smoke-devices.sh 的 Node 版，判据同一套）
 * ------------------------------------------------------------------ */

/** 只等响应头就断开（探 MJPEG 用；把流拉完会挂住） */
function probe(url, { timeout = 4000 } = {}) {
  const getter = url.startsWith("https:") ? https : http;
  return new Promise((resolve) => {
    const req = getter.get(url, (res) => {
      const result = { code: res.statusCode ?? 0, contentType: String(res.headers["content-type"] ?? "") };
      res.destroy();
      resolve(result);
    });
    req.on("error", (error) => resolve({ code: 0, contentType: "", error: error.code ?? "ERROR" }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ code: 0, contentType: "", error: "timeout" });
    });
    req.setTimeout(timeout);
  });
}

async function json(path, token) {
  try {
    const response = await fetch(`${BASE}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
    const text = await response.text();
    try {
      return { status: response.status, body: JSON.parse(text) };
    } catch {
      return { status: response.status, body: null, text: text.slice(0, 80) };
    }
  } catch (error) {
    return { status: 0, body: null, error: error?.message ?? "fetch failed" };
  }
}

/** 从外面按交接包判据算出结论（返回 { section: level[] } 与关键事实） */
async function outsideReadiness() {
  const health = await json("/api/health");
  if (health.status !== 200) return { unreachable: true, health };

  const index = await fetch(`${BASE}/`).then(async (response) => ({
    status: response.status,
    contentType: String(response.headers.get("content-type") ?? ""),
    hasRoot: (await response.text()).includes('id="root"'),
  })).catch(() => ({ status: 0, contentType: "", hasRoot: false }));

  const login = await json("/api/auth/login");
  /* 登录要 POST，上面 getter 只做 GET；这里单独发一次 */
  const tokenResponse = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: "mayutian", password: "123456" }),
  }).catch(() => null);
  const token = tokenResponse && tokenResponse.ok ? (await tokenResponse.json()).token : null;

  const cartStatus = await json("/api/cart/status", token);
  const streams = [];
  for (const channel of ["rviz", "camera"]) streams.push({ channel, ...(await probe(`${BASE}/api/cart/stream/${channel}`)) });
  const device = await json(`/api/devices/${DEVICE_ID}/hardware`, token);
  const preview = await probe(`${BASE}/api/devices/${DEVICE_ID}/preview/latest`);
  const screen = await json("/api/capture/screen/status", token);

  return {
    unreachable: false,
    health: health.body,
    login: login.status,
    index,
    token: Boolean(token),
    cartStatus: cartStatus.body,
    streams,
    device: device.body,
    preview,
    screen: screen.body,
  };
}

/* ------------------------------------------------------------------ *
 * 第二部分：真浏览器看页面
 * ------------------------------------------------------------------ */

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

console.log(`设备接入自检 · 平台 ${BASE}\n${"-".repeat(60)}`);

const outside = await outsideReadiness();
if (outside.unreachable) {
  console.log(`  [FAIL] 连不上 ${BASE}/api/health（后端没起，或这个地址上不是平台共享服务）`);
  console.log("         → pnpm build && node server/index.mjs --static dist");
  process.exit(2);
}

console.log(`从外面自检（交接包判据）：`);
check("/api/health 200 且报出服务名", outside.health?.service === "mumai-shared", `${outside.health?.service} v${outside.health?.version}`);
check("后端在同源托管前端（/ 返回 HTML 且含 #root）", outside.index.status === 200 && outside.index.hasRoot, `${outside.index.status} ${outside.index.contentType}`);
check("登录拿到平台令牌（脚本用的是 mayutian / 123456）", outside.token === true);
check(
  "小车：配置状态读数可判（configured / link）",
  typeof outside.cartStatus?.configured === "boolean" && typeof outside.cartStatus?.link === "string",
  `configured=${outside.cartStatus?.configured} link=${outside.cartStatus?.link}`,
);
check(
  "两路 MJPEG 的状态码可判（200 multipart / 502 小车没出帧 / 503 未配置）",
  outside.streams.length === 2 && outside.streams.every((item) => item.code !== 0),
  outside.streams.map((item) => `${item.channel}=${item.code}`).join(" "),
);
check(
  "手持扫描仪：上报新鲜度可判（report + ageSec）",
  outside.device !== null && ("report" in (outside.device ?? {})),
  `report=${outside.device?.report ? "有" : "null"} ageSec=${outside.device?.ageSec ?? "null"}`,
);
check("设备令牌组数可见（0 组 = 谁都连不上）", typeof outside.health?.devices?.tokens === "number", `${outside.health?.devices?.tokens} 组`);
check(
  "采集屏幕那一路：配置状态可判（可选）",
  typeof outside.screen?.configured === "boolean",
  `configured=${outside.screen?.configured} online=${outside.screen?.online}`,
);

/* ------------------------------------------------------------------ *
 * 第三部分：平台内的结论必须与外面一致
 * ------------------------------------------------------------------ */

const tokenResponse = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ account: "shi", password: "123456" }),
});
const shi = (await tokenResponse.json()).token;
const inside = await json("/api/device-readiness", shi);
const readiness = inside.body;
check("平台内自检接口可用（GET /api/device-readiness）", inside.status === 200 && Boolean(readiness), `HTTP ${inside.status}`);
check(
  "5 节结论齐全（0 平台 / 1 托管 / 2 小车 / 3 终端 / 4 屏幕）",
  readiness?.sections?.length === 5 && readiness.sections.map((s) => s.key).join(",") === "platform,hosting,cart,device,screen",
  readiness?.sections?.map((s) => s.title).join(" / "),
);
check(
  "小车那节与外面一致（没配 → FAIL）",
  outside.cartStatus?.configured === false
    ? readiness?.sections?.find((s) => s.key === "cart")?.items?.some((item) => item.level === "fail" && /小车地址没配/.test(item.title))
    : readiness?.sections?.find((s) => s.key === "cart")?.items?.some((item) => item.level === "ok"),
  readiness?.sections?.find((s) => s.key === "cart")?.items?.map((item) => item.level).join(","),
);
check(
  "终端那节与外面一致（从未上报 → FAIL）",
  outside.device?.report === null
    ? readiness?.sections?.find((s) => s.key === "device")?.items?.some((item) => item.level === "fail" && /一次都没上报过/.test(item.title))
    : readiness?.sections?.find((s) => s.key === "device")?.items?.some((item) => item.level === "ok" || item.level === "warn"),
  readiness?.sections?.find((s) => s.key === "device")?.items?.[0]?.title,
);
check(
  "退出码与交接包同一口径（有 FAIL = 1）",
  readiness?.exitCode === (readiness?.counts?.fail > 0 ? 1 : 0),
  `exitCode=${readiness?.exitCode} · 通过 ${readiness?.counts?.ok} / 提醒 ${readiness?.counts?.warn} / 失败 ${readiness?.counts?.fail}`,
);
check(
  "三份本地配置的落盘状态都给出（不存在也算一种状态）",
  readiness?.configs?.length === 3 && readiness.configs.every((item) => "present" in item && "placeholder" in item),
  readiness?.configs?.map((item) => `${item.file.split("/").pop()}=${item.present ? (item.placeholder ? "占位符" : "已填") : "不存在"}`).join(" "),
);

/* ------------------------------------------------------------------ *
 * 第四部分：真浏览器打开「硬件详情 → 设备接入」
 * ------------------------------------------------------------------ */

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
  if (!page) throw new Error("等不到可调试的页面");

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
    if (r.result?.exceptionDetails) throw new Error(`页面内抛错：${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`);
    return r.result?.result?.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");

  for (let i = 0; i < 80; i += 1) {
    if (await evaluate(`Boolean(document.querySelector('input'))`)) break;
    await sleep(250);
  }
  await evaluate(`(() => {
    const inputs = [...document.querySelectorAll('input')];
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
  for (let i = 0; i < 80; i += 1) {
    const hash = String(await evaluate(`location.hash`));
    if (!hash.includes("login") && (await evaluate(`document.querySelectorAll('nav button, nav a, aside button').length`)) > 0) break;
    await sleep(250);
  }

  await evaluate(`location.hash = '#/hardware?tab=access'`);
  let ready = false;
  for (let i = 0; i < 80; i += 1) {
    ready = await evaluate(`Boolean(document.querySelector('.da-summary') && document.querySelectorAll('.da-section').length === 5)`);
    if (ready) break;
    await sleep(250);
  }
  console.log(`\n页面（硬件详情 → 设备接入）：`);
  check("「设备接入」页签渲染出结论条与 5 节检查", ready, ready ? "就位" : "没等到 .da-summary / 5 个 .da-section");
  if (!ready) throw new Error("页面没渲染，后续检查没有意义");

  const summary = await evaluate(`(() => {
    const li = [...document.querySelectorAll('.da-summary li')].map((el) => ({
      key: el.querySelector('small')?.textContent.trim() ?? '',
      value: el.querySelector('b')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      note: el.querySelector(':scope > span')?.textContent.trim() ?? '',
      tone: el.className,
    }));
    const sections = [...document.querySelectorAll('.da-section')].map((el) => ({
      title: el.querySelector('header b')?.textContent.trim() ?? '',
      count: el.querySelector('header span')?.textContent.trim() ?? '',
      items: [...el.querySelectorAll('li')].map((item) => ({
        level: item.className,
        chip: item.querySelector('.chip')?.textContent.trim() ?? '',
        title: item.querySelector('.da-copy b')?.textContent.trim() ?? '',
        hints: item.querySelector('.da-hints')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      })),
    }));
    const table = [...document.querySelectorAll('.dtable tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.replace(/\\s+/g, ' ').trim()));
    const pitfalls = [...document.querySelectorAll('.da-pitfalls li')].map((el) => el.textContent.replace(/\\s+/g, ' ').trim());
    const notes = [...document.querySelectorAll('.note')].map((el) => el.textContent.replace(/\\s+/g, ' ').trim());
    return { li, sections, table, pitfalls, notes };
  })()`);

  check(
    "结论条按页面/接口同一份给出「通过 / 提醒 / 失败」三项计数",
    summary.li.length === 4 && summary.li.map((item) => item.key).join("|") === "总体结论|通过|提醒|失败",
    summary.li.map((item) => `${item.key}=${item.value}`).join(" · "),
  );
  check(
    "5 节标题与接口一致（0 平台服务 … 4 采集设备屏幕）",
    summary.sections.map((s) => s.title).join(" / ").includes("0 平台服务") &&
      summary.sections.map((s) => s.title).join(" / ").includes("4 采集设备屏幕"),
    summary.sections.map((s) => s.title).join(" / "),
  );
  check(
    "该 FAIL 的确实标成失败，并在同一条里写「改哪个文件」",
    summary.sections.some((s) => s.items.some((item) => item.level.includes("is-fail") && /server\/data\/cart\.json/.test(item.hints))),
    summary.sections
      .flatMap((s) => s.items)
      .filter((item) => item.level.includes("is-fail"))
      .map((item) => item.title)
      .join(" ／ "),
  );
  check(
    "终端那节写清终端侧三件事（platform_url / device_token / 必须重启）",
    summary.sections
      .flatMap((s) => s.items)
      .some((item) => /platform_url/.test(item.hints) && /device_token/.test(item.hints) && /重启终端进程/.test(item.hints)),
    summary.sections.flatMap((s) => s.items).find((item) => /platform_url/.test(item.hints))?.hints ?? "—",
  );
  check(
    "三份本地配置的表给出「文件 / 用途 / 状态 / 环境变量」四列",
    summary.table.length === 3 && summary.table.every((row) => row.length === 4) && summary.table.some((row) => /server\/data\/cart\.json/.test(row[0])),
    summary.table.map((row) => `${row[0]}=${row[2]}`).join(" · "),
  );
  check("三个最容易踩的坑写在页面上", summary.pitfalls.length === 3, summary.pitfalls.map((t) => t.slice(0, 18)).join(" ／ "));
  check(
    "验收命令与文档路径都在页面上（照着敲就能复核）",
    summary.notes.some((t) => /smoke-devices\.sh/.test(t) && /验收-设备接入\.mjs/.test(t) && /docs\/部署-设备画面排查交付-v1\.0\.md/.test(t)),
    summary.notes.find((t) => /smoke-devices\.sh/.test(t) && /验收-设备接入\.mjs/.test(t))?.slice(0, 130) ?? "—",
  );

  /* ---------- 小木能不能回答「为什么看不到小车」 ---------- */
  /*
    走**真实的唤醒事件**（mumai:xiaomu-ask，生产构建里也注册着），
    不用 window.__mumaiAsk —— 那个只在 DEV 构建里存在。
  */
  await evaluate(`(() => {
    window.dispatchEvent(new CustomEvent('mumai:xiaomu-ask', {
      detail: { question: '为什么看不到小车', interactionId: 'e2e-device-link-' + Date.now() },
    }));
    return true;
  })()`);

  let answer = null;
  for (let i = 0; i < 100; i += 1) {
    answer = await evaluate(`(() => {
      const dock = document.querySelector('.xd__panel');
      if (!dock) return null;
      return {
        intent: dock.querySelector('.xd__intent')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
        text: dock.querySelector('.xd__answer')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
        fold: dock.querySelector('.xd__fold-btn')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
        state: dock.querySelector('.xd__state')?.textContent.trim() ?? '',
      };
    })()`);
    if (answer?.text) break;
    await sleep(400);
  }

  /* 业务事实表默认折叠（渐进披露）：点开再读，否则读到的是空 */
  const facts = await evaluate(`(() => {
    const dock = document.querySelector('.xd__panel');
    const btn = [...(dock?.querySelectorAll('.xd__fold-btn') ?? [])].find((el) => el.textContent.includes('业务状态'));
    if (btn && btn.getAttribute('aria-expanded') !== 'true') btn.click();
    return true;
  })()`);
  await sleep(400);
  const factRows = await evaluate(`(() => {
    const dock = document.querySelector('.xd__panel');
    return [...(dock?.querySelectorAll('.xd__facts > div') ?? [])].map((row) => ({
      key: row.querySelector('dt')?.textContent.trim() ?? '',
      value: row.querySelector('dd')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    }));
  })()`);

  check(
    "小木按真实唤醒链路答「为什么看不到小车」",
    Boolean(answer?.text),
    answer?.text ? answer.text.slice(0, 120) : `没等到回答（气泡状态：${answer?.state ?? "无气泡"}）`,
  );
  check(
    "命中的是设备链路的自检意图（不是设备读数那条）",
    /device_link_check/.test(answer?.intent ?? ""),
    answer?.intent ?? "—",
  );
  check(
    "答案里的数与自检接口一致（同一份结论）",
    Boolean(answer?.text) && answer.text.includes(`${readiness?.counts?.fail} 项失败`),
    `接口 counts.fail=${readiness?.counts?.fail} · 回答「${(answer?.text ?? "").match(/\d+ 项失败/)?.[0] ?? "无"}」`,
  );
  check(
    "答案给出下一步怎么修（改哪个文件 / 重启什么），不是只说「没接上」",
    /server\/data\/cart\.json|MUMAI_CART_URL|重启后端|platform_url/.test(answer?.text ?? ""),
    (answer?.text ?? "").slice(-90),
  );
  check(
    "业务状态表默认折叠，点开后 6 项事实齐（判定 / 计数 / 小车 / 终端 / 配置 / 修法）",
    facts === true &&
      answer?.fold.includes("业务状态 6 项") === true &&
      ["linkVerdict", "linkCounts", "cartLine", "deviceLine", "configLine", "fixHint"].every((key) =>
        factRows.some((row) => row.key === key && row.value.length > 0),
      ),
    `${answer?.fold ?? "—"} · ${factRows.map((row) => `${row.key}=${row.value.slice(0, 20)}`).join(" | ")}`,
  );

  try {
    /* 等页面停稳再截图：断言时内容已在 DOM 里，但整页装载动画可能还盖在上面 */
    await sleep(1800);
    mkdirSync(SHOT_DIR, { recursive: true });
    const shot = await send("Page.captureScreenshot", { format: "png" });
    if (shot?.result?.data) {
      const file = `${SHOT_DIR}\\设备接入自检.png`;
      writeFileSync(file, Buffer.from(shot.result.data, "base64"));
      console.log(`  · 现场截图：${file}`);
    }
  } catch {
    /* 截图失败不影响结论 */
  }
} catch (error) {
  console.error(`  ✗ 工装自身出错：${error?.message ?? error}`);
  failed += 1;
} finally {
  chrome.kill();
}

console.log(
  `\n设备链路现状（供现场参考，不算本工装成败）：小车 configured=${outside.cartStatus?.configured} · ` +
    `设备上报=${outside.device?.report ? "有" : "无"} · 令牌 ${outside.health?.devices?.tokens} 组 · 屏幕 configured=${outside.screen?.configured}`,
);
console.log(failed === 0 ? "全部通过（设备接入 · 链路自检）" : `${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
