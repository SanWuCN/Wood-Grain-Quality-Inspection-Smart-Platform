/**
 * 小木形象 · 第 1 段：抠图（**只有这一步需要浏览器**）
 *
 * ── 为什么必须抠像素，而不是用 CSS 遮罩 ──────────────────────────────
 * 走了一段弯路，记下来：我一度想用 CSS `mask-image` 做出"背景透明 + 越靠中心越透明"，
 * 结果反复失败。根因是 —— **mask 只能改"不透明度"，改不了像素颜色**。
 * 参考图的球边缘本来就有一整圈**白色回光**、球心也偏白，这些白像素无论
 * 遮罩怎么调，显示出来仍然是白的。在深色底/棋盘底上就是一圈白边与一片白雾。
 * 所以"抠背景"这件事**必须在像素层面做**：算 alpha 并写进 PNG/WebP 的 alpha 通道。
 *
 * ── 之前为什么放弃过这条管线（真因，别再踩）─────────────────────────
 * 不是逻辑错，而是 **`chrome.kill()` 不会终止 Chrome 的子进程**，
 * Node 的事件循环被句柄挂着不退出 → 命令永远不返回，看起来像"卡死"。
 * 修法：收尾处 `setImmediate(() => process.exit(0))` 强制退出。
 *
 * ── alpha 模型（两层相乘）───────────────────────────────────────────
 *   径向因子：球心最透 → 轮廓最实（用户要的"越靠中心越透明"，轮廓必须回到 1，否则剪影化掉）
 *   亮度因子：越亮越透。这才是白边的解 —— 白色像素自然变透明，浅底观感不变、深底白边消失。
 * 例外：眼睛与嘴的实心部分**跳过亮度因子**，否则眼球会被自己内部的高光削透。
 *
 * 用法：node tools/rebuild/01-抠图.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";



const V = resolve("D:\\平台\\voice-module");
const REF = resolve("D:\\平台", "refs-xiaomu-main.png");
const OUT_DIR = resolve("D:\\平台", "xiaomu-assets");
const TMP = resolve(V, "tmp-cut.html");
const PROFILE = resolve(V, "tmp-cdp-cut");
const PORT = 9358;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 参考图实测几何 */
const W = 929, H = 903, CX = 464, CY = 451, R = 463.5;
const EYE_L = { x: 268, y: 333, w: 103, h: 110 };
const EYE_R = { x: 578, y: 385, w: 98, h: 105 };
const MOUTH = { x: 420, y: 475, w: 87, h: 33 };

/** 中心透明度（与页面滑杆默认值保持一致） */
const CENTER_ALPHA = 0.30;
/** 亮度衰减：0.90 以上开始变透，到 1.0 只剩这个比例 */
const LUM_START = 0.90, LUM_FLOOR = 0.22;
/** 输出尺寸（页面最大显示约 740 CSS px，600 宽足够，还能把体积压到几十 KB） */
const OUT_W = 600;

const PROCESSOR = `
window.__out = null; window.__err = null;
(async () => { try {
  const W = ${W}, H = ${H}, CX = ${CX}, CY = ${CY}, R = ${R};
  const EYE_L = { x: ${EYE_L.x}, y: ${EYE_L.y}, w: ${EYE_L.w}, h: ${EYE_L.h} };
  const EYE_R = { x: ${EYE_R.x}, y: ${EYE_R.y}, w: ${EYE_R.w}, h: ${EYE_R.h} };
  const MOUTH = { x: ${MOUTH.x}, y: ${MOUTH.y}, w: ${MOUTH.w}, h: ${MOUTH.h} };
  const CENTER_ALPHA = ${CENTER_ALPHA}, LUM_START = ${LUM_START}, LUM_FLOOR = ${LUM_FLOOR}, OUT_W = ${OUT_W};

  const img = new Image();
  img.src = window.__refSrc;
  await img.decode();
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, W, H);
  const d = id.data;

  /* 器官硬核：这些像素跳过亮度因子，保持实心 */
  /**
   * 器官的**完整保护圈**（不只是硬核）。
   *
   * ⚠ 这里踩过一个把眼睛吃掉的坑，记清楚：
   *   原实现让"亮度因子"作用在整个球内，只用一个 0.95 倍的"硬核"保护器官中心。
   *   可眼球本身是有渐变的（上深下亮），**亮的那半截**落在硬核之外 → 被亮度因子削到
   *   alpha≈0.22 → 抠完之后眼睛只剩两条 17×59 的碎片（参考图是 103×107）。
   *   肉眼在浅底上只看到"眼睛发虚"，很难想到是"抠图把眼球吃了一块"。
   *   修法：亮度因子**只作用于球外**；球内一律只走径向因子。
   *   球内的白雾本来由径向因子处理就够了（球心本来就最透），不需要再叠亮度规则。
   */
  const hard = new Uint8Array(W * H);
  const mark = (bx, by, bw, bh, grow) => {
    const cx2 = bx + bw / 2, cy2 = by + bh / 2;
    const rx = (bw / 2) * grow, ry = (bh / 2) * grow;
    for (let y = Math.max(0, Math.floor(cy2 - ry)); y <= Math.min(H - 1, Math.ceil(cy2 + ry)); y += 1) {
      for (let x = Math.max(0, Math.floor(cx2 - rx)); x <= Math.min(W - 1, Math.ceil(cx2 + rx)); x += 1) {
        const nx = (x - cx2) / rx, ny = (y - cy2) / ry;
        if (nx * nx + ny * ny <= 1) hard[y * W + x] = 1;
      }
    }
  };
  mark(EYE_L.x, EYE_L.y, EYE_L.w, EYE_L.h, 1.22);
  mark(EYE_R.x, EYE_R.y, EYE_R.w, EYE_R.h, 1.22);
  mark(MOUTH.x, MOUTH.y + MOUTH.h * 0.4, MOUTH.w, MOUTH.h * 0.9, 1.0);

  /**
   * 径向因子：球心 CENTER_ALPHA → 轮廓 1.00，**全程平滑羽化**。
   *
   * ⚠ 上一版是分段线性的，第一段写成 f<0.42 区间内从 CENTER_ALPHA 升到 0.43×rest，
   *   但球心那一档在 0 附近几乎是平的 —— 中心区会显出**一圈可见的边界**
   *   （用户口径：「中心羽化」，就是要求把这个平顶去掉）。
   * 现在改用**平滑曲线**：把 (1 − f) 做一次 smoothstep 幂次，
   *   球心最透、往外单调变实、轮廓处严格 1.0，整条曲线没有拐点。
   *   指数 1.35 是调过一轮的结果：太小则中心不够透（像蒙了层雾），
   *   太大则中心掉得太快（球心出现一个"洞"）。
   */
  const radial = (f) => {
    if (f <= 0) return CENTER_ALPHA;
    if (f >= 1) return 1;
    const x = 1 - f;
    const eased = x * x * (3 - 2 * x);          // smoothstep，端点一阶导为 0
    const t = Math.pow(eased, 1.35);
    return CENTER_ALPHA + (1 - CENTER_ALPHA) * (1 - t);
  };
  const luma = (v) => (v <= LUM_START ? 1 : 1 - ((v - LUM_START) / (1 - LUM_START)) * (1 - LUM_FLOOR));

  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 4;
      const dx = x - CX, dy = y - CY;
      const r = Math.sqrt(dx * dx + dy * dy);
      const lum = (0.2126 * d[i] + 0.7152 * d[i+1] + 0.0722 * d[i+2]) / 255;
      /*
        球外：按亮度抠白（外发光也是"亮"，越亮越透）
        球内：**只走径向因子**，不再叠亮度 —— 否则眼球亮的那半截会被削透明
        （见上面 hard 那段注释：这是把眼睛吃掉的真凶）
      */
      const a = r > R ? luma(lum) : radial(r / R);
      d[i+3] = Math.round(d[i+3] * Math.max(0, Math.min(1, a)));
    }
  }
  ctx.putImageData(id, 0, 0);


  /**
   * 把参考图里那条原嘴**洗掉**。
   *
   * 为什么放在这一步而不是页面层：页面上盖一块补丁会在深底上露出方块
   * （试过，被用户当场指出）。在像素层面直接用"该处球面的颜色"覆盖，
   * 边缘做柔和过渡，则不会有任何可见接缝 —— 因为被覆盖的就是球体自己的像素。
   */
  /**
   * 把参考图里那条原嘴**洗掉**（页面会用自己的矢量嘴重画）。
   *
   * ── 为什么"大面积涂掉"是错的（上一版的失败）─────────────────────────
   * 上一版用一个大椭圆把整片区域涂成球面色，结果把嘴**连同周围**一起洗白，
   * 只留下两个小白点 —— 看起来就是"嘴没了"。
   * 正确做法是**只洗深色线条本身**：
   *   · 只对深色像素动手（判据：平均亮度 < 0.62），球面的浅色像素一概不碰；
   *   · 每个被洗的像素用**它自己同一列上方**一小段的球面色替换（同列颜色最接近）；
   *   · 上下各扩 2px 做羽化，避免留下锯齿。
   * 这样球面一根像素都不动，只有那条嘴被擦掉，不会出现白块或补丁。
   */
  const eraseMouth = () => {
    const x0 = Math.max(1, Math.floor(MOUTH.x - MOUTH.w * 0.15));
    const x1 = Math.min(W - 2, Math.ceil(MOUTH.x + MOUTH.w * 1.15));
    const y0 = Math.max(1, Math.floor(MOUTH.y - MOUTH.h * 0.5));
    const y1 = Math.min(H - 2, Math.ceil(MOUTH.y + MOUTH.h * 1.5));
    const lumAt = (x, y) => { const i = (y * W + x) * 4;
      return (0.2126 * d[i] + 0.7152 * d[i+1] + 0.0722 * d[i+2]) / 255; };

    const need = [];
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        if (lumAt(x, y) < 0.62) need.push([x, y]);
      }
    }
    for (const [x, y] of need) {
      for (let dy = -2; dy <= 2; dy += 1) {
        const yy = y + dy;
        if (yy < 1 || yy >= H - 1) continue;
        const k = dy === 0 ? 1 : 1 - Math.abs(dy) / 3;            // 中心全替换，两侧羽化
        const sy2 = Math.max(1, y - Math.round(MOUTH.h * 1.1));   // 同一列、往上取球面色
        const si = (sy2 * W + x) * 4;
        const i2 = (yy * W + x) * 4;
        d[i2] = Math.round(d[i2] * (1 - k) + d[si] * k);
        d[i2+1] = Math.round(d[i2+1] * (1 - k) + d[si+1] * k);
        d[i2+2] = Math.round(d[i2+2] * (1 - k) + d[si+2] * k);
      }
    }
    ctx.putImageData(id, 0, 0);
  };
  eraseMouth();
  /* 缩到输出尺寸再导出：600 宽的 WebP 带 alpha 通常只有几十 KB */
  const out = document.createElement("canvas");
  out.width = OUT_W; out.height = Math.round(H * OUT_W / W);
  const octx = out.getContext("2d");
  octx.imageSmoothingQuality = "high";
  octx.drawImage(cv, 0, 0, out.width, out.height);
  const webp = out.toDataURL("image/webp", 0.95);
  const png = out.toDataURL("image/png");
  const bytes = (u) => Math.round((u.length - u.indexOf(",") - 1) * 3 / 4);

  window.__out = {
    webp: webp.startsWith("data:image/webp") ? webp : null,
    png,
    size: [out.width, out.height],
    webpBytes: webp.startsWith("data:image/webp") ? bytes(webp) : 0,
    pngBytes: bytes(png),
  };
} catch (e) { window.__err = String((e && e.stack) || e); } })();
`;

const b64 = readFileSync(REF).toString("base64");
writeFileSync(
  TMP,
  '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>\n' +
  '<script>window.__refSrc = "data:image/png;base64,' + b64 + '";</' + 'script>\n' +
  '<script>' + PROCESSOR + '</' + 'script>\n</body></html>',
  "utf8",
);

const chromeExe = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
].find((p) => existsSync(p));

mkdirSync(OUT_DIR, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });
const chrome = spawn(chromeExe, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--no-first-run", "--disable-extensions", `file:///${TMP.replace(/\\/g, "/")}`,
], { stdio: "ignore" });

try {
  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i += 1) {
    await sleep(400);
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      wsUrl = l.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null;
    } catch { /* 还没起 */ }
  }
  if (!wsUrl) throw new Error("等不到可调试页面");
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const waiting = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async (x) => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;

  let out = null;
  for (let i = 0; i < 60 && !out; i += 1) { await sleep(500); out = await ev("window.__out"); }
  if (!out) throw new Error("抠图失败，页面内异常：" + (await ev("window.__err")));

  // 只用 ASCII 文件名：页面要在 5199/5200 两个静态服务下都能取到，中文名容易被漏转义
  const name = out.webp ? "xiaomu-cut.webp" : "xiaomu-cut.png";
  writeFileSync(resolve(OUT_DIR, name), Buffer.from((out.webp || out.png).split(",")[1], "base64"));
  const kb = (Math.max(out.webpBytes, out.pngBytes) / 1024).toFixed(0);
  console.log("抠图完成 → " + resolve(OUT_DIR, name) + "（" + out.size.join("×") + "，" + kb + " KB）");
  console.log("  页面引用路径：xiaomu-assets/" + name);
  ws.close();
} finally {
  chrome.kill();
  rmSync(TMP, { force: true });
  /*
    ⚠ 必须强制退出。`chrome.kill()` 只终止主进程，Chrome 那一堆子进程的句柄
    仍挂在 Node 的事件循环上 → 命令永远不返回，看起来像"脚本卡死"。
    这条坑让整条管线被误判为不可用、白白回退了一轮，记在这里。
  */
  setImmediate(() => process.exit(process.exitCode ?? 0));
}

