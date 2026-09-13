/**
 * 药丸填充态时间序列扫描（临时验证用）
 *
 * 沿一条横穿所有药丸的扫描线，逐帧把像素分成：
 *   bg   顶栏底色（很暗）
 *   blue 蓝调（选中项的 rgba(78,168,255,.26) 叠在深底上 → 约 rgb(27,54,90)）
 *   cyan 青调（悬停圆：--glow-cyan 20%→8% 叠在深底上 → b−r 明显更大）
 * 输出每一帧各药丸的填充状态与指针位置，用来看：
 *   ① 同一帧里是否有多枚药丸同时是 cyan（说明状态残留）
 *   ② 指针已经离开药丸后，cyan 是否还在（说明该收没收）
 *
 * 用法：
 *   node tools/video-pill-scan.mjs --file tmp-shot/vid/bug.mp4 --y 262 --fps 12
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
const y = Number(arg("y", "262"));
const fps = Number(arg("fps", "12"));
const x0 = Number(arg("x0", "40"));
const x1 = Number(arg("x1", "1000"));
const out = resolve(arg("out", "tmp-shot/vid/pill-scan.json"));
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
const debugPort = 9111 + Math.floor(Math.random() * 200);
const chrome = spawn(
  findChrome(),
  [
    "--headless=new",
    "--no-sandbox",
    "--no-first-run",
    "--autoplay-policy=no-user-gesture-required",
    `--user-data-dir=${resolve("tmp-shot", `pscan-${debugPort}`)}`,
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

const result = await send("Runtime.evaluate", {
  awaitPromise: true,
  returnByValue: true,
  expression: `(async () => {
    const v = document.querySelector('video');
    await new Promise((r) => { if (v.readyState >= 1) return r(); v.addEventListener('loadedmetadata', r); });
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const X0 = ${x0}, X1 = ${x1}, Y = ${y};
    const W = X1 - X0;

    /*
      分类阈值是实测出来的，不是猜的：
        选中项底色（rgba(78,168,255,.26) 叠在深底）≈ rgb(27,54,90)  → g−r=27
        悬停圆（--glow-cyan 20%→8% 叠在深底）        ≈ rgb(20,50,74)  → g−r=30，且 b−r 更大、更暗
      两者靠「青色程度」很难分开，但它们**宽度**完全不同（选中 230px、悬停圆 100–160px），
      所以这里干脆不分类，只输出每个连续色块的宽度与样本色，由人读。
    */
    const classify = (r, g, b) => {
      if (r < 18 && g < 20 && b < 34) return 'bg';
      if (b - r > 26) return 'fill';   // 蓝底或青圆，都会落到这里
      return 'other';
    };

    const frames = [];
    const dur = v.duration;
    const step = 1 / ${fps};
    for (let t = 0; t <= dur; t += step) {
      await new Promise((res) => {
        const done = () => { v.removeEventListener('seeked', done); res(); };
        v.addEventListener('seeked', done);
        v.currentTime = Math.min(t, dur - 0.001);
        setTimeout(() => { v.removeEventListener('seeked', done); res(); }, 3000);
      });
      ctx.drawImage(v, 0, 0);
      const d = ctx.getImageData(X0, Y, W, 1).data;
      const runs = [];
      for (let i = 0; i < W; i += 1) {
        const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
        const k = classify(r, g, b);
        const last = runs[runs.length - 1];
        if (last && last.k === k) { last.to = i + X0; last.n++; }
        else runs.push({ k, from: i + X0, to: i + X0, n: 1 });
      }
      /* 只看够长的段：药丸填充是 40px 以上的连续色块 */
      const blocks = runs.filter((r2) => r2.n >= 20 && r2.k === 'fill')
        .map((r2) => {
          const mid = Math.round((r2.from + r2.to) / 2);
          const i = (mid - X0) * 4;
          return r2.from + '-' + r2.to + '(' + (r2.to - r2.from) + ')' +
            ' rgb(' + d[i] + ',' + d[i + 1] + ',' + d[i + 2] + ')';
        });
      frames.push({ t: Number(t.toFixed(2)), blocks });
    }
    return { dur, y: Y, frames };
  })()`,
});
const value = result.result.value;
writeFileSync(out, JSON.stringify(value, null, 1));
console.log(`[scan] y=${value.y} ${value.frames.length} 帧，${value.dur.toFixed(2)}s → ${out}`);
for (const f of value.frames) {
  console.log(`t=${String(f.t).padStart(5)}s  ${f.blocks.join('  ') || '(无填充)'}`);
}
ws.close();
chrome.kill();
server.close();
process.exit(0);
