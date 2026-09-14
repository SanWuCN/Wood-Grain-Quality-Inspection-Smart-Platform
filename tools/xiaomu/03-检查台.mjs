/**
 * 小木形象与动效 · 检查台生成器
 *
 * 产出两个页面：
 *   ① <repo>/dist-lab/rebuild/index.html   —— 动效素材总览（**运行时读 assets.json，数据驱动**）
 *   ② <repo>/dist-lab/xiaomu-rebuild.html  —— 形象本体（参考图 + 几何动画）
 *
 * ── 重构后的设计要点 ────────────────────────────────────────────────
 * 1. **数据驱动**：动效素材由 `D:\平台\rebuild\assets.json` 描述，页面在运行时 fetch 它并渲染卡片。
 *    加/换一个视频**不需要改这个生成器**：替换 src/ 下的 mp4 → 重跑抠图 → 更新 assets.json。
 * 2. **产物不内联**：GIF 每个约 1.4 MB，内联进 HTML 会让首屏很慢；它们由同一静态服务提供，直接相对路径引用。
 * 3. **透明必须在棋盘底／深底上验**：浅色纯底上"透明"与"浅灰"看不出区别。
 * 4. 两个页面共用同一套 CSS 与背景切换脚本（`SHARED_CSS` / `BG_SCRIPT`），避免两处样式漂移。
 *
 * 用法：node tools/rebuild/03-检查台.mjs
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = "D:\\平台\\Wood-Grain-Quality-Inspection-Smart-Platform-RAO\\Wood-Grain-Quality-Inspection-Smart-Platform-RAO";
const REBUILD = "D:\\平台\\rebuild";
const OUT_HUB = resolve(REPO, "dist-lab", "rebuild", "index.html");
const OUT_BODY = resolve(REPO, "dist-lab", "xiaomu-rebuild.html");

/* ── 参考图实测几何（与 01-抠图 同源）── */
const W = 929, H = 903;
const CX = 464, CY = 451, R = 463.5;
const EYE_L = { x: 268, y: 333, w: 103, h: 110 };
const EYE_R = { x: 578, y: 385, w: 98, h: 105 };
const MOUTH = { x: 420, y: 475, w: 87, h: 33 };

const pct = (v, t) => ((v / t) * 100).toFixed(4) + "%";
const eyeC = (e) => ({ cx: e.x + e.w / 2, cy: e.y + e.h / 2, rx: e.w / 2, ry: e.h / 2 });
/** 眼皮倾角：实测两眼连线 +9.51°（CSS rotate 正方向为顺时针） */
const TILT = (Math.atan2((EYE_R.y + EYE_R.h / 2) - (EYE_L.y + EYE_L.h / 2),
  (EYE_R.x + EYE_R.w / 2) - (EYE_L.x + EYE_L.w / 2)) * 180) / Math.PI;

const lidBox = (e) => {
  const k = eyeC(e);
  const rx = k.rx * 1.26, ry = k.ry * 1.36;
  return "left:" + pct(k.cx - rx, W) + ";top:" + pct(k.cy - ry, H) + ";" +
         "width:" + pct(rx * 2, W) + ";height:" + pct(ry * 2, H) + ";";
};

/** 嘴：形状由"逐行统计深色像素"定出（中部最低 → 浅笑），整体 −7.8° 倾角 */
const mouthSvg = () => {
  const x0 = MOUTH.x + MOUTH.w * 0.02, x1 = MOUTH.x + MOUTH.w * 0.98;
  const yEnd = MOUTH.y + MOUTH.h * 0.12, yCtl = MOUTH.y + MOUTH.h * 0.78;
  return '<svg class="mouthOverlay" viewBox="0 0 ' + W + " " + H +
    '" style="position:absolute;inset:0;width:100%;height:100%" aria-hidden="true">' +
    '<g transform="rotate(-7.8 ' + (MOUTH.x + MOUTH.w / 2) + " " + (MOUTH.y + MOUTH.h / 2) + ')">' +
    '<path d="M' + x0 + " " + yEnd + " Q" + (MOUTH.x + MOUTH.w / 2) + " " + yCtl + " " + x1 + " " + yEnd + '" ' +
    'fill="none" stroke="#16295c" stroke-width="' + (MOUTH.w * 0.125).toFixed(1) + '" stroke-linecap="round"/></g></svg>';
};

/** 思考：一只手摸下巴（自画，不照搬任何平台的 emoji 素材） */
const thinkingHand = () => {
  const w = R * 1.0, h = R * 0.6;
  const left = CX + R * 0.10, top = CY + R * 0.48;
  return '<svg class="think" viewBox="0 0 100 62" style="left:' + pct(left, W) + ";top:" + pct(top, H) +
    ";width:" + pct(w, W) + ";height:" + pct(h, H) + '" role="img" aria-label="思考中">' +
    '<path d="M14 44 q-3 -18 10 -21 q13 -3 17 9 q2 7 0 14 q-3 12 -16 12 q-12 0 -11 -14 z" fill="#e8f1ff" stroke="#33538c" stroke-width="2.6" stroke-linejoin="round"/>' +
    '<path d="M26 30 q-1 -13 6 -14 q7 -1 8 11" fill="none" stroke="#33538c" stroke-width="2.4" stroke-linecap="round"/>' +
    '<path d="M38 28 q0 -13 7 -13 q7 0 7 12" fill="none" stroke="#33538c" stroke-width="2.4" stroke-linecap="round"/>' +
    '<path d="M50 30 q1 -11 7 -11 q6 0 6 11" fill="none" stroke="#33538c" stroke-width="2.4" stroke-linecap="round"/>' +
    '<path d="M22 42 q-12 -4 -13 6 q-1 8 9 9" fill="none" stroke="#33538c" stroke-width="2.6" stroke-linecap="round"/></svg>';
};

/** 两个页面共用的样式 */
const SHARED_CSS = `
  html, body { margin: 0; background: #eef1f7; color: #1b2437;
    font-family: "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif; }
  .wrap { max-width: 1240px; margin: 0 auto; padding: 22px 20px 60px; }
  h1 { font-size: 19px; margin: 0 0 6px; }
  .sub { font-size: 12.5px; color: #4b5a75; line-height: 1.75; max-width: 96ch; margin: 0 0 16px; }
  .bar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center;
    background: #fff; border: 1px solid #d8e0ee; border-radius: 10px; padding: 10px 14px; margin-bottom: 14px; }
  .bar .sep { width: 1px; height: 22px; background: #d8e0ee; }
  .kv { font-size: 12.5px; color: #55637d; }
  .kv b { color: #1b2437; }
  button { font: inherit; font-size: 12.5px; padding: 6px 12px; border-radius: 8px;
    border: 1px solid #b9c7de; background: #fff; cursor: pointer; }
  button[aria-pressed=true] { background: #2f7fe0; border-color: #2f7fe0; color: #fff; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 18px; }
  .card { background: #fff; border: 1px solid #d8e0ee; border-radius: 12px; overflow: hidden; }
  .card header { padding: 10px 14px; border-bottom: 1px solid #e6ebf5; }
  .card h3 { margin: 0; font-size: 14px; }
  .card header p { margin: 4px 0 0; font-size: 12px; color: #55637d; line-height: 1.6; }
  .card .meta { padding: 9px 14px; font-size: 12px; color: #55637d; line-height: 1.7; }
  .card .meta b { color: #1b2437; }
  /* 棋盘底：唯一能证明透明的背景。深底暴露白边、浅底暴露黑边 */
  .stage { position: relative; aspect-ratio: 1 / 1; display: grid; place-items: center; overflow: hidden;
    background-color: var(--cb1); background-image:
      linear-gradient(45deg, var(--cb2) 25%, transparent 25%, transparent 75%, var(--cb2) 75%),
      linear-gradient(45deg, var(--cb2) 25%, transparent 25%, transparent 75%, var(--cb2) 75%);
    background-size: 24px 24px; background-position: 0 0, 12px 12px; }
  .stage.nochecker { background-image: none; background-color: #ffffff; }
  #root { --cb1: #f4f7fc; --cb2: #e3e9f4; }
  #root[data-dark="1"] { --cb1: #101828; --cb2: #1c2637; }
  .asset { max-width: 92%; max-height: 92%; display: block; }
  .note { margin-top: 18px; font-size: 12.5px; color: #4b5a75; line-height: 1.85;
    background: #fff; border: 1px solid #d8e0ee; border-radius: 10px; padding: 12px 16px; }
  .note b { color: #1b2437; }
  code { background: #eef2f9; padding: 1px 5px; border-radius: 4px; }
`;

/** 背景切换（两页共用） */
const BG_SCRIPT = `
(() => {
  const root = document.documentElement;
  const modes = { "cb-light": "light", "cb-dark": "dark", "cb-solid": "solid" };
  const setBg = (mode) => {
    for (const [id, m] of Object.entries(modes)) {
      const b = document.getElementById(id);
      if (b) b.setAttribute("aria-pressed", String(m === mode));
    }
    root.dataset.dark = mode === "dark" ? "1" : "0";
    for (const s of document.querySelectorAll(".stage")) s.classList.toggle("nochecker", mode === "solid");
  };
  for (const id of Object.keys(modes)) {
    const b = document.getElementById(id);
    if (b) b.addEventListener("click", () => setBg(modes[id]));
  }
  setBg("light");
  window.__setBg = setBg;
})();
`;

/* ══════════════════════════════════════════════════════════════════
 * ① 素材总览页（数据驱动）
 * ══════════════════════════════════════════════════════════════════ */
const hub = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>小木动效素材 · 透明检查</title>
<style>${SHARED_CSS}
  .vids .stage { aspect-ratio: auto; padding: 8px 0; }
</style>
</head>
<body>
<div class="wrap" id="root">
  <h1>小木动效素材 · 透明检查</h1>
  <p class="sub">
    读 <code>assets.json</code> 自动列出素材。GIF 与 WebM 都是<b>透明底</b>，请在<b>棋盘底／深底</b>上验
    —— 浅色纯底上"透明"和"浅灰"分不出来。
    换素材：替换 <code>src/*.mp4</code> → 跑 <code>tools/video/抠透明GIF.mjs</code> → 更新 <code>assets.json</code>。
  </p>

  <div class="bar">
    <span class="kv">背景：</span>
    <button id="cb-light" aria-pressed="true" type="button">浅棋盘</button>
    <button id="cb-dark" aria-pressed="false" type="button">深棋盘</button>
    <button id="cb-solid" aria-pressed="false" type="button">纯白</button>
    <span class="sep"></span>
    <label class="kv"><input id="showSrc" type="checkbox" /> 显示原视频对照</label>
  </div>

  <div class="grid" id="grid"></div>
  <div id="state" class="kv" style="margin-top:14px">读取 assets.json…</div>

  <div class="note">
    <p><b>抠图模型</b>（<code>tools/video/抠透明GIF.mjs</code>，ffmpeg 实现）：先量背景（顶部/底部各一条），
    再<b>自动选键类型</b> —— 背景色度偏离中性灰 &gt; 0.06 用<b>色度键</b>（绿幕类素材），否则用<b>亮度键</b>（浅灰底素材）。
    最后加<b>空间约束</b>：球半径之外一律全透、球心圆内强制不透明（保住眼睛与嘴）。</p>
    <p><b>验证</b>（<code>tools/video/验透明.mjs</code>）三条判据：四角透明 / 中心不透明 / alpha 直方图里有"半透明"桶
    （有过渡带 = 软键生效、不会锯齿）。<b>ffmpeg 返回 0 完全不能说明抠图成功</b> —— 透明丢失时它照样成功退出。</p>
    <p><b>GIF 的固有限制</b>：只有 1 位透明（二值），边缘的半透明过渡会被阈值化成硬边。
    要真正平滑的边缘请用 <b>WebM(VP9+alpha)</b> —— 实测体积约为 GIF 的 1/30。</p>
  </div>
</div>
<script>
${BG_SCRIPT}
(() => {
  const grid = document.getElementById("grid");
  const state = document.getElementById("state");
  const esc = (s) => String(s == null ? "" : s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

  const sizeOf = async (url) => {
    try { const r = await fetch(url, { method: "HEAD" });
      return r.ok ? ((+r.headers.get("content-length") || 0) / 1024).toFixed(0) + " KB" : "取不到";
    } catch { return "取不到"; }
  };

  (async () => {
    let data;
    try {
      const r = await fetch("assets.json", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      data = await r.json();
    } catch (e) {
      state.innerHTML = '<b style="color:#7d2020">读不到 assets.json</b>（' + esc(String(e && e.message || e)) +
        '）。确认这个目录下有 assets.json，且是通过静态服务打开的（不要用 file:// 直接双击）。';
      return;
    }
    const items = data.items || [];
    for (const it of items) {
      const el = document.createElement("section");
      el.className = "card";
      el.innerHTML =
        '<header><h3>' + esc(it.title) + '</h3><p>' + esc(it.desc || "") + '</p></header>' +
        '<div class="stage"><img class="asset" id="img-' + esc(it.id) + '" src="' + esc(it.gif) +
          '" alt="' + esc(it.title) + '（透明 GIF）" /></div>' +
        '<div class="meta" id="m-' + esc(it.id) + '">读取中…</div>' +
        '<div class="stage vids"><video class="asset" src="' + esc(it.webm) +
          '" autoplay loop muted playsinline style="max-height:200px"></video></div>' +
        '<div class="meta" id="mw-' + esc(it.id) + '">读取中…</div>';
      grid.appendChild(el);
      const v = it.verify || {}, k = it.key || {};
      document.getElementById("m-" + it.id).innerHTML =
        'GIF <b>' + (await sizeOf(it.gif)) + '</b>　四角透明 <b>' + esc(v.corner || "?") +
        '</b>　中心不透明 <b>' + esc(v.center || "?") + '</b>　过渡带 <b>' + esc(v.soft || "?") +
        '</b>　键 <b>' + esc(k.mode || "auto") + '</b>/solid ' + esc(k.solid ?? "-");
      document.getElementById("mw-" + it.id).innerHTML =
        'WebM(VP9+alpha) <b>' + (await sizeOf(it.webm)) + '</b>　—　同样透明，体积小得多，边缘更干净';
    }
    state.innerHTML = '共 <b>' + items.length + '</b> 项，来自 <code>assets.json</code>' +
      (data.pipeline ? '　｜　管线 <code>' + esc(data.pipeline) + '</code>' : '');

    document.getElementById("showSrc").addEventListener("change", (e) => {
      for (const it of items) {
        const img = document.getElementById("img-" + it.id);
        if (!img) continue;
        const box = img.parentElement;
        const old = box.querySelector("video");
        if (e.target.checked && !old) {
          const v = document.createElement("video");
          v.src = it.src; v.autoplay = true; v.loop = true; v.muted = true; v.playsInline = true;
          v.className = "asset";
          img.style.display = "none";
          box.appendChild(v);
        } else if (!e.target.checked && old) {
          old.remove(); img.style.display = "";
        }
      }
    });
  })();
})();
</script>
</body>
</html>`;

/* ══════════════════════════════════════════════════════════════════
 * ② 形象本体页
 * ══════════════════════════════════════════════════════════════════ */
const bodyPage = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>小木形象 · 检查</title>
<style>${SHARED_CSS}
  .ball { position: absolute; inset: 0; transform-origin: 50% 50%; animation: float 5.6s ease-in-out infinite; }
  @keyframes float { 0%,100% { transform: translateY(0) scale(1); } 50% { transform: translateY(-1.6%) scale(1.025); } }
  .ball img, .ball svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  /* 眼皮：直线矩形 + 羽化渐变 + 按实测倾角旋转（不要圆形眼皮、不要白斑） */
  .lid { position: absolute; border-radius: 0; transform-origin: 50% 0%; background: transparent;
    -webkit-backdrop-filter: blur(2px) brightness(1.22) saturate(0.72);
    backdrop-filter: blur(2px) brightness(1.22) saturate(0.72);
    animation: lidBlink var(--blink) linear infinite; }
  .lid--r { animation-delay: 0.024s; }
  @keyframes lidBlink {
    0% { transform: rotate(var(--lidTilt)) scaleY(0); }
    2% { transform: rotate(var(--lidTilt)) scaleY(1); }
    3.4% { transform: rotate(var(--lidTilt)) scaleY(1); }
    5.6% { transform: rotate(var(--lidTilt)) scaleY(0); }
    100% { transform: rotate(var(--lidTilt)) scaleY(0); } }
  .think { position: absolute; opacity: 0; visibility: hidden; transition: opacity .22s ease, visibility .22s; pointer-events: none; }
  .thinking .think { opacity: 1; visibility: visible; animation: bob 2.4s ease-in-out infinite; }
  @keyframes bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-4%); } }
  .thinking .mouthOverlay { opacity: 0; }
  .talking .mouthOverlay { animation: talk .42s ease-in-out infinite; transform-origin: 50% 45%; }
  @keyframes talk { 0%,100% { transform: scaleY(1); } 35% { transform: scaleY(1.7); } 70% { transform: scaleY(0.75); } }
  .tag { position: absolute; top: 8px; left: 8px; font-size: 11px; padding: 4px 8px;
    border-radius: 6px; background: rgba(255,255,255,.9); border: 1px solid #d8e0ee; }
</style>
</head>
<body>
<div class="wrap" id="root">
  <h1>小木形象 · 检查</h1>
  <p class="sub">
    底图是抠过背景的参考图（带 alpha，越靠中心越透明）；眼睛的洞由球体遮罩挖出、不叠第二张图；
    眼皮是<b>带倾角的渐变覆盖蒙版</b>；嘴是矢量重画（参考图那条已在抠图阶段擦掉）。
    <b>透明请在棋盘底／深底上看。</b>
  </p>

  <div class="bar">
    <span class="kv">背景：</span>
    <button id="cb-light" aria-pressed="true" type="button">浅棋盘</button>
    <button id="cb-dark" aria-pressed="false" type="button">深棋盘</button>
    <button id="cb-solid" aria-pressed="false" type="button">纯白</button>
    <span class="sep"></span>
    <span class="kv">状态：</span>
    <button class="state" data-state="idle" aria-pressed="true" type="button">待机</button>
    <button class="state" data-state="talking" type="button">说话</button>
    <button class="state" data-state="thinking" type="button">思考</button>
  </div>

  <div class="grid">
    <section class="card">
      <header><h3>小木 · 待机 / 说话 / 思考</h3>
        <p>待机是几何动画（参考图 + 矢量嘴 + 眼皮）｜说话与思考直接用 <code>rebuild/</code> 下的透明 GIF</p></header>
      <div class="stage" id="stageAvatar">
        <div class="ball" id="ball">
          <img id="base" src="/xiaomu-assets/xiaomu-cut.webp" alt="小木" />
          <span class="lid" style="${lidBox(EYE_L)}"></span>
          <span class="lid lid--r" style="${lidBox(EYE_R)}"></span>
          ${mouthSvg()}
          ${thinkingHand()}
        </div>
        <img id="clipplay" class="asset" alt="" aria-hidden="true" style="display:none" />
        <span class="tag" id="tagAvatar">参考图 + 几何动画</span>
      </div>
      <div class="meta">动效素材（透明 GIF / WebM）在 <a href="/rebuild/index.html">素材检查页</a>。</div>
    </section>
  </div>
</div>
<script>
${BG_SCRIPT}
(() => {
  const root = document.documentElement;
  const ball = document.getElementById("ball");
  root.style.setProperty("--lidTilt", ${JSON.stringify(TILT.toFixed(2))} + "deg");
  root.style.setProperty("--blink", "5.2s");
  /*
    三态：
      idle     → 几何动画（底图 + 矢量嘴 + 眼皮）
      talking  → 直接播 rebuild/gif/speak.gif（透明 GIF）
      thinking → 直接播 rebuild/gif/think.gif
    为什么说话/思考改用 GIF：这两套表情（口型开合、皱眉抬眼）是**素材里真实画出来的**，
    用矢量几何去"模拟"只会像而不像；直接播素材既准确又省事。
    待机仍用几何动画，因为它要跟着 5.6s 呼吸浮动、还要能调球心透明度。
  */
  const clipplay = document.getElementById("clipplay");
  const tag = document.getElementById("tagAvatar");
  const CLIP = { talking: "/rebuild/gif/speak.gif", thinking: "/rebuild/gif/think.gif" };
  const setState = (name) => {
    ball.classList.remove("talking", "thinking");
    if (name !== "idle") ball.classList.add(name);
    const clip = CLIP[name];
    if (clip) {
      clipplay.src = clip;
      clipplay.style.display = "";
      ball.style.visibility = "hidden";
      tag.textContent = name === "talking" ? "说话 · 透明 GIF" : "思考 · 透明 GIF";
    } else {
      clipplay.style.display = "none";
      clipplay.removeAttribute("src");
      ball.style.visibility = "";
      tag.textContent = "参考图 + 几何动画";
    }
    document.querySelectorAll(".state").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.state === name)));
  };
  document.querySelectorAll(".state").forEach((b) => b.addEventListener("click", () => setState(b.dataset.state)));
  Object.defineProperty(window, "__xiaomuCheck", { value: Object.freeze({ setState, setBg: window.__setBg }), configurable: true });
})();
</script>
</body>
</html>`;

writeFileSync(OUT_HUB, hub, "utf8");
writeFileSync(OUT_BODY, bodyPage, "utf8");
writeFileSync(resolve(REBUILD, "index.html"), hub, "utf8");
console.log("已写出：");
console.log("  " + OUT_HUB + "（" + (Buffer.byteLength(hub, "utf8") / 1024).toFixed(0) + " KB，运行时读 assets.json）");
console.log("  " + OUT_BODY + "（" + (Buffer.byteLength(bodyPage, "utf8") / 1024).toFixed(0) + " KB）");
console.log("  " + resolve(REBUILD, "index.html") + "（同内容，源目录留档）");
