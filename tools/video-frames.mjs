/**
 * 视频抽帧工具（临时验证用）
 *
 * 本机没有 ffmpeg，所以借 Chrome 自己的解码器抽帧：
 * 起一个只服务一个目录的静态服务器 → headless Chrome 打开一个小页面把 mp4
 * 挂进 <video> → 用 CDP 逐帧 seek → drawImage 到 canvas → dataURL 落盘。
 *
 * 用法：
 *   node tools/video-frames.mjs --file tmp-shot/vid/bug.mp4 --fps 4 --out tmp-shot/vid/frames
 *   node tools/video-frames.mjs --file ... --times 0.5,1.2,3.4     # 指定秒数
 *   node tools/video-frames.mjs --file ... --crop x,y,w,h          # 只截这一块（放大看细节）
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

const file = resolve(arg("file"));
const outDir = resolve(arg("out", "tmp-shot/vid/frames"));
const fps = Number(arg("fps", "4"));
const timesArg = arg("times", "");
const cropArg = arg("crop", "");
const maxFrames = Number(arg("max", "60"));
if (!existsSync(file)) throw new Error(`找不到视频：${file}`);

const MIME = { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime" };
const html = readFileSync(resolve("tools/video-frames.html"), "utf8");

/* ---- 1. 静态服务器：支持 Range，否则 <video> 无法 seek ---- */
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/" || path === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  if (path !== "/video") {
    res.writeHead(404).end();
    return;
  }
  const size = statSync(file).size;
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : size - 1;
    res.writeHead(206, {
      "content-type": type,
      "accept-ranges": "bytes",
      "content-range": `bytes ${start}-${end}/${size}`,
      "content-length": end - start + 1,
    });
    res.end(readFileSync(file).subarray(start, end + 1));
    return;
  }
  res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

/* ---- 2. headless Chrome + CDP ---- */
const debugPort = 9333 + Math.floor(Math.random() * 400);
const profile = resolve("tmp-shot", `vidprofile-${debugPort}`);
const chrome = spawn(
  findChrome(),
  [
    "--headless=new",
    "--no-sandbox",
    "--no-first-run",
    "--disable-extensions",
    "--autoplay-policy=no-user-gesture-required",
    "--force-device-scale-factor=1",
    "--window-size=1400,900",
    `--user-data-dir=${profile}`,
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
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
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
await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval 失败");
  return r.result.value;
}

/* 等 <video> 拿到元数据 */
let meta = null;
for (let i = 0; i < 60; i++) {
  meta = await evaluate(`(() => {
    const v = document.querySelector('video');
    if (!v) return null;
    return { duration: v.duration, w: videoWidth(v), h: videoHeight(v) };
    function videoWidth(v){ return v.videoWidth; }
    function videoHeight(v){ return v.videoHeight; }
  })()`);
  if (meta && Number.isFinite(meta.duration) && meta.duration > 0) break;
  await sleep(250);
}
if (!meta || !Number.isFinite(meta.duration)) throw new Error("读不到视频元数据（编解码不支持？）");
console.log(`[meta] ${meta.w}x${meta.h} duration=${meta.duration.toFixed(2)}s`);

/* ---- 3. 逐帧 seek + 抽帧 ---- */
const times = timesArg
  ? timesArg.split(",").map(Number)
  : Array.from({ length: Math.min(maxFrames, Math.max(1, Math.ceil(meta.duration * fps))) }, (_, i) =>
      Number(((i + 0.5) / fps).toFixed(3)),
    );

mkdirSync(outDir, { recursive: true });
const crop = cropArg ? cropArg.split(",").map(Number) : null;
const written = [];
for (const [i, t] of times.entries()) {
  const dataUrl = await evaluate(`(async () => {
    const v = document.querySelector('video');
    await new Promise((res, rej) => {
      const done = () => { v.removeEventListener('seeked', done); res(); };
      v.addEventListener('seeked', done);
      v.currentTime = ${t};
      setTimeout(() => { v.removeEventListener('seeked', done); res(); }, 4000);
    });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const c = document.createElement('canvas');
    const crop = ${crop ? JSON.stringify(crop) : "null"};
    const sx = crop ? crop[0] : 0, sy = crop ? crop[1] : 0;
    const sw = crop ? crop[2] : v.videoWidth, sh = crop ? crop[3] : v.videoHeight;
    c.width = sw; c.height = sh;
    const ctx = c.getContext('2d');
    ctx.drawImage(v, sx, sy, sw, sh, 0, 0, sw, sh);
    return c.toDataURL('image/png');
  })()`);
  const name = `f${String(i).padStart(3, "0")}_t${String(t).replace(".", "p")}.png`;
  writeFileSync(join(outDir, name), Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64"));
  written.push(name);
}
console.log(`[frames] ${written.length} 张 → ${outDir}`);
console.log(written.join(" "));

ws.close();
chrome.kill();
server.close();
process.exit(0);
