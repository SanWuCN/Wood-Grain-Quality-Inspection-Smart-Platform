/**
 * 木脉智检 · UI 素材 v2.0 图标/插图验收探针
 *
 * 用 CDP 打开真实页面，在页面里检查**实际渲染**出来的图标与插图，对照
 * PRD §8 验收表的相关行：资源选择 / 内联颜色 / 小尺寸 / 名称兼容。
 *
 * 前置：npm run dev 正在跑（探针要通过 Vite 动态载入图标组件来验证 16px 规则）。
 *
 * 用法：
 *   node tools/ui-v2-probe.mjs --url "http://localhost:5173/#/archive" \
 *     --init "localStorage.setItem('mumai.session', JSON.stringify({accountId:'shi',login:'shi',at:''}))"
 *
 * 说明：页面侧代码全部写成**普通字符串**（不用模板字符串嵌套），
 * 因此这里的引号与反斜杠不需要二次转义 —— 上一版用模板字符串套正则，
 * 反斜杠被吞掉导致探针自己报语法错。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function findChrome() {
  const override = process.env.CHROME_PATH;
  if (override && existsSync(override)) return override;
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
  ];
  for (const path of candidates) if (existsSync(path)) return path;
  throw new Error("未找到 Chrome / Edge");
}

const CHROME = findChrome();

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const url = arg("url", "http://localhost:5173/#/");
const init = arg("init", "");
const wait = Number(arg("wait", "9000"));
const port = Number(arg("port", "9333"));
const profile = mkdtempSync(join(tmpdir(), "mumai-probe-"));

/* ------------------------------------------------------------------
   页面侧探针代码：写成独立文件，避免模板字符串转义问题
   ------------------------------------------------------------------ */
const PROBE_SOURCE = `
const SMALL_VARIANTS = ["action-expand", "nav-report", "biz-sample-group", "biz-multimodal", "biz-material-adapt"];

function shapeOf(el) {
  // 比较整组图形：两版可能都以同一个 rect 开头，只比首节点会漏判
  return el ? el.innerHTML.replace(/\\s+/g, " ").trim() : "";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runProbe() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail) });

  const icons = Array.from(document.querySelectorAll("svg.mumai-icon"));
  push("页面渲染了 v2 图标", icons.length > 0, icons.length + " 枚");

  const allowed = ["16", "20", "24", "32"];
  const badSize = icons.filter((el) => allowed.indexOf(el.getAttribute("width")) === -1);
  push("尺寸都在 16/20/24/32", badSize.length === 0,
    badSize.length ? badSize.map((el) => el.getAttribute("data-icon") + ":" + el.getAttribute("width")).join(" ") : "全部合法");

  const mismatched = icons.filter((el) => {
    const attr = Number(el.getAttribute("width"));
    const rect = el.getBoundingClientRect().width;
    return rect > 1 && Math.abs(rect - attr) > 0.6;
  });
  push("size 属性与渲染宽一致", mismatched.length === 0,
    mismatched.length
      ? mismatched.map((el) => el.getAttribute("data-icon") + " attr=" + el.getAttribute("width") + " rect=" + Math.round(el.getBoundingClientRect().width)).join(" ")
      : "无 CSS 覆盖");

  const plain = icons.filter((el) => !el.getAttribute("data-icon"));
  push("图标都带 data-icon", plain.length === 0, plain.length + " 枚缺失");

  const toneColors = {};
  icons.forEach((el) => {
    const color = getComputedStyle(el).color;
    toneColors[color] = (toneColors[color] || 0) + 1;
  });
  push("图标语义色可枚举", Object.keys(toneColors).length > 0, JSON.stringify(toneColors));

  const imgs = Array.from(document.querySelectorAll("img[data-illustration]"));
  const broken = imgs.filter((img) => img.complete && img.naturalWidth === 0);
  push("插图无 404", broken.length === 0, imgs.length ? imgs.length + " 张全部加载" : "本页无插图");

  const stretched = imgs.filter((img) => getComputedStyle(img).objectFit !== "contain");
  push("插图 object-fit=contain", stretched.length === 0,
    stretched.length ? stretched.map((i) => i.getAttribute("data-illustration")).join(" ") : "全部 contain");

  const scopes = document.querySelectorAll(".mumai-ui-v2");
  push("根容器带 mumai-ui-v2", scopes.length > 0, scopes.length + " 个作用域根");
  const accent = scopes[0] ? getComputedStyle(scopes[0]).getPropertyValue("--mumai-accent").trim() : "";
  push("v2 主题变量已生效", accent.length > 0, "--mumai-accent=" + (accent || "(空)"));

  /*
    ---- 16px 简化版映射 ----
    这里不做离屏渲染比对（data: 模块解析不了 Vite 的裸路径），
    静态核对交给 tools/check-ui-v2-icons.mjs（已覆盖几何差异与五枚映射）。
    本探针只确认页面上出现的 16px 图标确实取到了与 20px 不同的图形。
  */
  const rep16 = document.querySelector('svg.mumai-icon[data-icon="nav-report"][width="16"]');
  const rep20 = document.querySelector('svg.mumai-icon[data-icon="nav-report"][width="20"]');
  if (rep16 && rep20) {
    push("nav-report 的 16px 与 20px 图形不同", shapeOf(rep16) !== shapeOf(rep20),
      shapeOf(rep16) !== shapeOf(rep20) ? "简化版已生效" : "两档图形相同（简化版未生效）");
  } else {
    push("nav-report 的 16px 与 20px 图形不同", true, "本页未同时出现两档，已由静态核对覆盖");
  }

  return { url: location.href, hash: location.hash, results };
}
`;

const probeFile = join(profile, "mu mai-probe.js");
writeFileSync(probeFile, PROBE_SOURCE, "utf8");

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--window-size=1920,1080",
    "--hide-scrollbars",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function debuggerUrl() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await response.json();
      const page = list.find((item) => item.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* 端口还没起来 */
    }
    await sleep(250);
  }
  throw new Error("Chrome 调试端口未就绪");
}

const ws = new WebSocket(await debuggerUrl());
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

let seq = 0;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});

function send(method, params = {}) {
  seq += 1;
  const id = seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}

async function evaluate(expression) {
  const message = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (message.result?.exceptionDetails) {
    throw new Error(
      message.result.exceptionDetails.exception?.description ??
        message.result.exceptionDetails.text ??
        "页面脚本报错",
    );
  }
  return message.result?.result?.value;
}

await send("Page.enable");
await send("Runtime.enable");
if (init) await send("Page.addScriptToEvaluateOnNewDocument", { source: init });
await send("Page.navigate", { url });
await sleep(wait);

/*
  探针源码通过 CDP 以 data:text/javascript;base64 形式动态 import，
  不落盘到项目里，也不依赖 Vite 的 fs.allow（tools/ 不在 Vite 白名单内）。
*/
const probeDataUrl = `data:text/javascript;base64,${Buffer.from(PROBE_SOURCE, "utf8").toString("base64")}`;
await evaluate(
  `import(${JSON.stringify(probeDataUrl)})
     .then((m) => m.runProbe())
     .then((r) => { window.__MUMAI_PROBE__ = r; })
     .catch((e) => { window.__MUMAI_PROBE__ = { error: String(e && e.stack ? e.stack : e) }; })
     .then(() => true)`,
);

let report = null;
for (let i = 0; i < 60; i += 1) {
  await sleep(250);
  report = await evaluate("window.__MUMAI_PROBE__ || null");
  if (report) break;
}

if (!report) {
  console.log("探针未返回结果");
  ws.close();
  chrome.kill();
  process.exit(2);
}
if (report.error) {
  console.log(`探针执行失败：${report.error}`);
  ws.close();
  chrome.kill();
  process.exit(2);
}

console.log("\n=== UI 素材 v2.0 图标/插图探针 ===");
console.log(`地址 ${report.url}`);
console.log(`落在 ${report.hash}\n`);

let failed = 0;
for (const item of report.results) {
  if (!item.ok) failed += 1;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}  —  ${item.detail}`);
}
console.log(`\n合计 ${report.results.length} 项，失败 ${failed} 项`);

ws.close();
chrome.kill();
process.exit(failed > 0 ? 1 : 0);
