/**
 * 药丸横向定位（临时验证用）
 *
 * 沿药丸所在的那一行扫一遍，按颜色分类，输出连续区段：
 *   - 暗蓝底（rgb 大约 20-35）且 b > r：药丸的悬停/选中填充
 *   - 青绿（g、b 都高、r 低）：圆的淡青填充
 * 药丸之间的间隙是接近纯黑的顶栏底色，于是区段边界就是药丸边界。
 *
 * 用法：node tools/video-row-scan.mjs --file tmp-shot/vid/bug.mp4 --t 4 --y 262 --x 0,1000
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
  for (const p of candidates) if (existsSync(p)) return p;
  throw new Error("未找到 Chrome");
}
function arg(name, fb) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fb;
}
const file = resolve(arg("file"));
const t = Number(arg("t", "4"));
const y = Number(arg("y", "262"));
const [x0, x1] = arg("x", "0,1000").split(",").map(Number);
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
      const s = m && m[1] ? Number(m[1]) : 0;
      const e = m && m[2] ? Number(m[2]) : size - 1;
      res.writeHead(206, {
        "content-type": type,
        "accept-ranges": "bytes",
        "content-range": `bytes ${s}-${e}/${size}`,
        "content-length": e - s + 1,
      });
      res.end(readFileSync(file).subarray(s, e + 1));
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
const debugPort = 9888 + Math.floor(Math.random() * 100);
const chrome = spawn(
  findChrome(),
  [
    "--headless=new",
    "--no-sandbox",
    "--no-first-run",
    "--autoplay-policy=no-user-gesture-required",
    `--user-data-dir=${resolve("tmp-shot", `row-${debugPort}`)}`,
    `--remote-debugging-port=${debugPort}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function endpoint() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
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
    await new Promise((r) => { if (v.readyState >= 1) return r(); v.addEventListener('loadedmetadata', r); });
    await new Promise((r) => { const d = () => { v.removeEventListener('seeked', d); r(); }; v.addEventListener('seeked', d); v.currentTime = ${t}; });
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0);
    const W = ${x1} - ${x0};
    const d = ctx.getImageData(${x0}, ${y}, W, 1).data;
    const rows = [];
    for (let i = 0; i < W; i += 2) {
      rows.push([i + ${x0}, d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]);
    }
    /* 分类连续段 */
    const kind = ([, r, g, b]) => {
      if (r < 14 && g < 18 && b < 30) return 'bg';
      if (g > 55 && b > 70 && b > r + 10 && g > r + 5) return 'fill';
      if (r > 200 && g > 210 && b > 220) return 'text';
      return 'other';
    };
    const segs = [];
    for (const px of rows) {
      const k = kind(px);
      const last = segs[segs.length - 1];
      if (last && last.k === k) last.to = px[0];
      else segs.push({ k, from: px[0], to: px[0], sample: px.slice(1).join(',') });
    }
    return segs.filter((s) => s.to - s.from >= 6);
  })()`,
});
for (const s of out.result.value) {
  console.log(`${s.k.padEnd(6)} x ${String(s.from).padStart(4)}..${String(s.to).padStart(4)}  rgb(${s.sample})`);
}
ws.close();
chrome.kill();
server.close();
process.exit(0);
