/**
 * 抽帧联系表（contact sheet）生成器（临时验证用）
 *
 * 把 tools/video-frames.mjs 抽出来的一堆 PNG 拼成一张带时间标注的网格图：
 * 一屏就能看出「哪几帧开始不对」，再去读那几帧的原图，比一帧帧翻快得多。
 * 同样借 Chrome 渲染（本机没有 ffmpeg / sharp）。
 *
 * 用法：
 *   node tools/video-sheet.mjs --dir tmp-shot/vid/frames --out tmp-shot/vid/sheet.png
 *   node tools/video-sheet.mjs --dir ... --cols 4 --cell 480 --crop 0,30,1920,70
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

function findChrome() {
  const override = process.env.CHROME_PATH;
  if (override && existsSync(override)) return override;
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : ["/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  for (const path of candidates) if (existsSync(path)) return path;
  throw new Error("未找到 Chrome，请设置 CHROME_PATH");
}

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dir = resolve(arg("dir"));
const out = resolve(arg("out", "tmp-shot/vid/sheet.png"));
const cols = Number(arg("cols", "3"));
const cell = Number(arg("cell", "600"));
const crop = arg("crop", "");

const files = readdirSync(dir)
  .filter((f) => f.toLowerCase().endsWith(".png"))
  .sort();
if (!files.length) throw new Error(`目录里没有 PNG：${dir}`);

/* 每格上方写文件名里的时间戳（f012_t2p5.png → 2.5s） */
const label = (name) => {
  const m = /_t([\d]+)p(\d+)\.png$/.exec(name);
  return m ? `${m[1]}.${m[2]}s` : name;
};

const html = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; background: #05080d; font: 12px/1.4 Consolas, monospace; color: #9fb4cc; }
  .grid { display: grid; grid-template-columns: repeat(${cols}, ${cell}px); gap: 6px; padding: 8px; }
  figure { margin: 0; }
  img { display: block; width: ${cell}px; image-rendering: pixelated; border: 1px solid #1d3category; }
  figcaption { padding: 2px 0; }
</style>
<div class="grid">
${files
  .map(
    (f) => `  <figure><img src="/f/${encodeURIComponent(f)}"><figcaption>${label(f)}</figcaption></figure>`,
  )
  .join("\n")}
</div>`;

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html.replace("#1d3category", "#1d3348"));
    return;
  }
  if (path.startsWith("/f/")) {
    const name = path.slice(3);
    if (files.includes(name)) {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(readFileSync(join(dir, name)));
      return;
    }
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const debugPort = 9777 + Math.floor(Math.random() * 200);
const chrome = spawn(
  findChrome(),
  [
    "--headless=new",
    "--no-sandbox",
    "--no-first-run",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--window-size=1200,900",
    `--user-data-dir=${resolve("tmp-shot", `sheetprofile-${debugPort}`)}`,
    `--remote-debugging-port=${debugPort}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function endpoint() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch {
      /* not up */
    }
    await sleep(250);
  }
  throw new Error("devtools endpoint 没起来");
}

const ws = new WebSocket(await endpoint());
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});
let seq = 0;
const pending = new Map();
let sessionId = null;
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve: res, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : res(msg.result);
  }
};
function send(method, params = {}, useSession = true) {
  const id = ++seq;
  const payload = { id, method, params };
  if (useSession && sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
}

const { targetId } = await send("Target.createTarget", { url: "about:blank" }, false);
sessionId = (await send("Target.attachToTarget", { targetId, flatten: true }, false)).sessionId;
await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
await sleep(1200);

const size = await send("Runtime.evaluate", {
  expression: `(() => { const b = document.body; return { w: b.scrollWidth, h: b.scrollHeight }; })()`,
  returnByValue: true,
});
const { w, h } = size.result.value;
await send("Emulation.setDeviceMetricsOverride", {
  width: Math.min(w, 2400),
  height: Math.min(h, 8000),
  deviceScaleFactor: 1,
  mobile: false,
});
await sleep(900);

const shotParams = { format: "png", captureBeyondViewport: true };
if (crop) {
  const [x, y, cw, ch] = crop.split(",").map(Number);
  shotParams.clip = { x, y, width: cw, height: ch, scale: 1 };
}
const shot = await send("Page.captureScreenshot", shotParams);
mkdirSync(resolve(out, ".."), { recursive: true });
writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log(`[sheet] ${files.length} 帧 → ${out} (${w}x${h})`);

ws.close();
chrome.kill();
server.close();
process.exit(0);
