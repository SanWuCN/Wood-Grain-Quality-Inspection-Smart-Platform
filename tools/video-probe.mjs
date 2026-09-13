/**
 * 视频帧定位工具（临时验证用）
 *
 * 在某一帧上按行/列统计“与顶栏底色接近”的像素，把顶栏与药丸的像素范围找出来。
 * 抽帧时 crop 的坐标必须精确，靠肉眼估会一错再错；这里直接量。
 *
 * 用法：
 *   node tools/video-probe.mjs --file tmp-shot/vid/bug.mp4 --t 4 --range 0,400
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";

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
const t = Number(arg("t", "4"));
const [from, to] = arg("range", "0,400").split(",").map(Number);
const MIME = { ".mp4": "video/mp4", ".webm": "video/webm" };

const server = createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><video src="/video" muted playsinline></video>`);
    return;
  }
  if (path === "/video") {
    const size = statSync(file).size;
    const range = req.headers.range;
    const type = MIME[extname(file).toLowerCase()] ?? "video/mp4";
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
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const debugPort = 9555 + Math.floor(Math.random() * 300);
const chrome = spawn(
  findChrome(),
  [
    "--headless=new",
    "--no-sandbox",
    "--no-first-run",
    "--autoplay-policy=no-user-gesture-required",
    `--user-data-dir=${resolve("tmp-shot", `probe-${debugPort}`)}`,
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
  throw new Error("devtools 没起来");
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
await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
await sleep(1500);

const out = await send("Runtime.evaluate", {
  awaitPromise: true,
  returnByValue: true,
  expression: `(async () => {
    const v = document.querySelector('video');
    await new Promise((res) => { if (v.readyState >= 1) return res(); v.addEventListener('loadedmetadata', res); });
    await new Promise((res) => { const d = () => { v.removeEventListener('seeked', d); res(); }; v.addEventListener('seeked', d); v.currentTime = ${t}; });
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(v, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, Math.min(${to}, c.height));
    const rows = [];
    for (let y = ${from}; y < Math.min(${to}, c.height); y++) {
      let dark = 0, teal = 0, blue = 0;
      for (let x = 0; x < 1100; x++) {
        const i = (y * c.width + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (r < 40 && g < 45 && b < 60) dark++;
        if (g > 150 && b > 180 && r < 140) teal++;
        if (b > 120 && r < 110 && g < 160) blue++;
      }
      rows.push([y, dark, teal, blue]);
    }
    return { w: c.width, h: c.height, rows: rows.filter(([, d, t2, b2]) => d > 400 || t2 > 20 || b2 > 20) };
  })()`,
});
console.log(JSON.stringify(out.result.value, null, 1));
ws.close();
chrome.kill();
server.close();
process.exit(0);
