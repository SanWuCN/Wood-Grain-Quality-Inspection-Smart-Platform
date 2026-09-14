/**
 * 量新参考图的几何（一次性，跑完保留为工装）
 *
 * 为什么要重量：换图之后**球心、半径、眼嘴位置、倾角全都会变**。
 * 沿用旧图的数字会让五官整体错位 —— 这类错误在截图上看是"脸歪了"，
 * 很难反推回"坐标没重测"，所以每次换图都必须重新量。
 *
 * 判据（与旧图同口径，保证可比）：
 *   轮廓 = 逐行"非白"包围盒的最宽行（背景接近纯白 253,254,254）
 *   五官 = 球内 0.75R 范围内、按行/列投影切出的深色组件
 *
 * 用法：node tools/量参考图.mjs [图片URL]
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const V = resolve("D:\\平台\\voice-module");
const REF = process.argv[2] || "D:\\平台\\refs-xiaomu-main.png";
const TMP = resolve(V, "tmp-measure.html");
const PROFILE = resolve(V, "tmp-cdp-measure");
const PORT = 9360;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b64 = readFileSync(REF).toString("base64");
writeFileSync(TMP, `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>
window.__out = null; window.__err = null;
(async () => { try {
  const img = new Image();
  img.src = "data:image/png;base64,${b64}";
  await img.decode();
  const W = img.naturalWidth, H = img.naturalHeight;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, W, H).data;
  const at = (x, y) => { const i = (y * W + x) * 4; return [d[i], d[i+1], d[i+2], d[i+3]]; };

  /* 轮廓：非白判据（背景是接近纯白的灰白） */
  const isBg = (p) => { const mx = Math.max(p[0],p[1],p[2]), mn = Math.min(p[0],p[1],p[2]);
    return p[3] < 8 || (mn > 232 && mx - mn < 9); };
  let widest = { y: 0, w: -1, l: 0, r: 0 }, top = -1, bottom = -1, leftMost = W, rightMost = -1;
  for (let y = 0; y < H; y += 1) {
    let l = -1, r = -1;
    for (let x = 0; x < W; x += 1) if (!isBg(at(x, y))) { l = x; break; }
    for (let x = W - 1; x >= 0; x -= 1) if (!isBg(at(x, y))) { r = x; break; }
    if (l < 0) continue;
    if (top < 0) top = y;
    bottom = y;
    if (l < leftMost) leftMost = l;
    if (r > rightMost) rightMost = r;
    if (r - l > widest.w) widest = { y, w: r - l, l, r };
  }
  const CX = Math.round((widest.l + widest.r) / 2), CY = widest.y, R = widest.w / 2;

  /* 五官：球内 0.75R 的深色像素，按行投影切带、再按列投影分组 */
  const isInk = (p) => (p[0] + p[1] + p[2]) / 3 < 150 && p[3] > 100;
  const pts = [];
  for (let y = Math.round(CY - 0.75 * R); y <= Math.round(CY + 0.75 * R); y += 1) {
    for (let x = Math.round(CX - 0.75 * R); x <= Math.round(CX + 0.75 * R); x += 1) {
      if ((x - CX) ** 2 + (y - CY) ** 2 > (0.75 * R) ** 2) continue;
      if (isInk(at(x, y))) pts.push([x, y]);
    }
  }
  const rows = new Map();
  for (const [x, y] of pts) rows.set(y, (rows.get(y) || 0) + 1);
  const ys = [...rows.keys()].sort((a, b) => a - b);
  const bands = []; let cur = null;
  for (const y of ys) { if (!cur || y > cur[1] + 4) { cur = [y, y]; bands.push(cur); } else cur[1] = y; }
  const comps = [];
  for (const [y0, y1] of bands) {
    const seg = pts.filter(([, y]) => y >= y0 && y <= y1);
    const cols = new Map();
    for (const [x] of seg) cols.set(x, (cols.get(x) || 0) + 1);
    const xs = [...cols.keys()].sort((a, b) => a - b);
    const groups = []; let gg = null;
    for (const x of xs) { if (!gg || x > gg[1] + 8) { gg = [x, x]; groups.push(gg); } else gg[1] = x; }
    for (const [x0, x1] of groups) {
      const cell = seg.filter(([x]) => x >= x0 && x <= x1);
      const yy = cell.map(([, y]) => y);
      comps.push({ x: x0, y: Math.min(...yy), w: x1 - x0 + 1, h: Math.max(...yy) - Math.min(...yy) + 1, px: cell.length });
    }
  }
  /* 按像素数从大到小：通常前两个是眼睛、最小的是嘴 */
  comps.sort((a, b) => b.px - a.px);
  const eyes = comps.slice(0, 2).sort((a, b) => a.x - b.x);
  const mouth = comps[2] || null;

  window.__out = {
    size: [W, H],
    ball: { cx: CX, cy: CY, r: +R.toFixed(1), top, bottom, leftMost, rightMost },
    eyes, mouth, allComponents: comps,
    ratios: {
      R_over_W: +(R / W).toFixed(4),
      eyeW_over_R: eyes[0] ? +((eyes[0].w + (eyes[1] ? eyes[1].w : eyes[0].w)) / 2 / R).toFixed(4) : null,
      eyeH_over_R: eyes[0] ? +((eyes[0].h + (eyes[1] ? eyes[1].h : eyes[0].h)) / 2 / R).toFixed(4) : null,
      eyeDX_over_R: eyes[0] && eyes[1] ? +(((eyes[1].x + eyes[1].w / 2) - (eyes[0].x + eyes[0].w / 2)) / 2 / R).toFixed(4) : null,
      eyeCY_over_R: eyes[0] ? +(((eyes[0].y + eyes[0].h / 2) + (eyes[1] ? eyes[1].y + eyes[1].h / 2 : 0)) / 2 - CY).toFixed(1) : null,
      eyeTiltDeg: eyes[0] && eyes[1]
        ? +((Math.atan2((eyes[1].y + eyes[1].h / 2) - (eyes[0].y + eyes[0].h / 2),
                        (eyes[1].x + eyes[1].w / 2) - (eyes[0].x + eyes[0].w / 2)) * 180) / Math.PI).toFixed(2)
        : null,
    },
  };
} catch (e) { window.__err = String((e && e.stack) || e); } })();
<\/script></body></html>`, "utf8");

const exe = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`].find((p) => existsSync(p));
rmSync(PROFILE, { recursive: true, force: true });
const chrome = spawn(exe, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, "--no-first-run", "--disable-extensions", `file:///${TMP.replace(/\\/g, "/")}`], { stdio: "ignore" });
try {
  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i += 1) {
    await sleep(400);
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); wsUrl = l.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null; } catch { /* */ }
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0; const w = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (w.has(m.id)) { w.get(m.id)(m); w.delete(m.id); } });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; w.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (x) => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;
  let out = null;
  for (let i = 0; i < 40 && !out; i += 1) { await sleep(500); out = await ev("window.__out"); }
  if (!out) throw new Error("量测失败：" + (await ev("window.__err")));
  console.log(JSON.stringify(out, null, 1));
  ws.close();
} finally {
  chrome.kill();
  rmSync(TMP, { force: true });
  setImmediate(() => process.exit(process.exitCode ?? 0));
}
