/**
 * CDP 截图 / 控制台检查工具（临时验证脚本，验收后删除）
 *
 * 用法：
 *   node tools/shot.mjs --url http://localhost:5173/ --out tmp-shot/ov-china.png --wait 7000
 *   node tools/shot.mjs --url ... --eval "window.dispatchEvent(new CustomEvent('mumai:request-mode',{detail:'shanghai'}))" --wait 4000
 *   node tools/shot.mjs --url ... --drag 160,0
 *   node tools/shot.mjs --url ... --move 577,760 --click 577,760   # 指定坐标悬停 / 点击
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * 自动探测 Chrome / Chromium。
 *
 * 原来写死 Windows 路径，在 macOS 上会直接 ENOENT —— 而这个工具是全平台唯一的
 * 视觉验收手段（截图 + 设计规范探针 + console 收集），必须跨平台可用。
 * 顺序按「本机最可能装的位置」排，命中即用；也支持用 CHROME_PATH 环境变量覆盖。
 */
function findChrome() {
  const override = process.env.CHROME_PATH;
  if (override && existsSync(override)) return override;

  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
        ]
      : process.platform === "win32"
        ? [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
          ];

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  throw new Error(
    `未找到 Chrome / Chromium。请安装后重试，或用 CHROME_PATH=/path/to/chrome 指定。\n已尝试：\n  ${candidates.join("\n  ")}`,
  );
}

const CHROME = findChrome();

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const url = arg("url", "http://localhost:5173/");
const out = resolve(arg("out", "tmp-shot/shot.png"));
const wait = Number(arg("wait", "7000"));
const width = Number(arg("w", "1920"));
const height = Number(arg("h", "1080"));
const evalExpr = arg("eval", "");
const evalAfter = arg("evalAfter", "");
const drag = arg("drag", "");
/**
 * --init "<js>"：在目标页面的**所有脚本之前**执行。
 * 登录改版后 / 受 RequireLogin 保护，未登录会被重定向到 #/login，
 * 截图前必须先把会话写进 localStorage，而普通 --eval 跑在页面加载之后，
 * 那时重定向已经发生。用法：
 *   --init "localStorage.setItem('mumai.session', JSON.stringify({accountId:'shen',login:'shen',at:''}))"
 */
const initScript = arg("init", "");
const port = 9222 + Math.floor(Math.random() * 400);

mkdirSync(dirname(out), { recursive: true });

// GPU 模式：用真实显卡跑 ANGLE/D3D11，避免 SwiftShader 软件渲染把画面压黑
const glFlags = process.argv.includes("--gpu")
  ? ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu"]
  : ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"];

const profile = resolve("tmp-shot", `profile-${port}`);
const logFd = process.argv.includes("--log")
  ? openSync(resolve("tmp-shot", `chrome-${port}.log`), "w")
  : "ignore";
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    ...glFlags,
    ...(process.argv.includes("--log") ? ["--enable-logging=stderr", "--v=1"] : []),
    "--disable-gpu-sandbox",
    "--no-sandbox",
    "--no-first-run",
    "--disable-extensions",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--window-size=${width},${height}`,
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "about:blank",
  ],
  { stdio: ["ignore", logFd, logFd] },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function endpoint() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("chrome devtools endpoint never came up");
}

const wsUrl = await endpoint();
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});

let seq = 0;
const pending = new Map();
const logs = [];
let sessionId = null;

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve: res, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : res(msg.result);
    return;
  }
  const m = msg.method;
  if (m === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    logs.push(`[exception] ${d.exception?.description ?? d.text}`);
  } else if (m === "Runtime.consoleAPICalled") {
    const text = msg.params.args
      .map((a) => a.value ?? a.description ?? a.type)
      .join(" ");
    if (msg.params.type === "log") {
      if (process.argv.includes("--alllogs")) logs.push(`[log] ${text}`);
    } else if (["error", "warning"].includes(msg.params.type)) {
      logs.push(`[console.${msg.params.type}] ${text}`);
    }
  } else if (m === "Log.entryAdded" && msg.params.entry.level === "error") {
    /*
      ⚠ **必须把 `entry.url` 一起记下来**（2026-09-16 实测踩到）：
      "Failed to load resource: 503" 这类条目，`text` 里**没有**是哪个资源，
      唯一的凭据在 `entry.url`。原来只 push `entry.text`，于是下游
      （`accept.mjs` 的错误分类）拿不到 URL，无法判断这是"本机未接入的外设链路"
      还是"真正的服务故障"，只能一律算失败 —— 建图巡航页因此长期假红。
    */
    const where = msg.params.entry.url ? ` @ ${msg.params.entry.url}` : "";
    logs.push(`[log] ${msg.params.entry.text}${where}`);
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
const attached = await send("Target.attachToTarget", { targetId, flatten: true }, false);
sessionId = attached.sessionId;

await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
// 尽早挂上 WebGL 上下文事件钩子，抓上下文丢失/恢复的原因
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__gl = [];
    (() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, attrs) {
        const ctx = orig.call(this, type, attrs);
        if (ctx && (type === 'webgl2' || type === 'webgl' || type === 'webgpu') && !this.__hooked) {
          this.__hooked = true;
          window.__gl.push('created ' + type + ' ' + this.width + 'x' + this.height);
          this.addEventListener('webglcontextlost', (e) => {
            window.__gl.push('LOST ' + (e.statusMessage || 'no-message'));
          });
          this.addEventListener('webglcontextrestored', () => window.__gl.push('restored'));
        }
        return ctx;
      };
      window.addEventListener('error', (e) => window.__gl.push('error ' + e.message));
      window.addEventListener('unhandledrejection', (e) => window.__gl.push('reject ' + e.reason));
    })();`,
});
await send("Emulation.setDeviceMetricsOverride", {
  width,
  height,
  deviceScaleFactor: 1,
  mobile: false,
});
/**
 * --reduced-motion：把 prefers-reduced-motion 模拟成 reduce。
 *
 * 走 CDP 的媒体特性模拟，而不是在页面里改写 window.matchMedia ——
 * 后者对「模块加载时就取过一次 matchMedia 结果」的代码无效，
 * 也测不出 CSS 里那条 @media (prefers-reduced-motion) 是否真的生效。
 * 必须在 Page.navigate 之前设置，首帧就是降级态（评审 V13 要验的就是这个）。
 */
if (process.argv.includes("--reduced-motion")) {
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
}
if (initScript) {
  await send("Page.addScriptToEvaluateOnNewDocument", { source: initScript });
}
await send("Page.navigate", { url });

await sleep(wait);

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return r?.result?.value;
}

if (evalExpr) {
  const v = await evaluate(evalExpr);
  const dumpPng = arg("dumpPng", "");
  if (dumpPng) {
    const b64 = String(v).replace(/^data:image\/png;base64,/, "");
    writeFileSync(resolve(dumpPng), Buffer.from(b64, "base64"));
    console.log(`[dumpPng] ${dumpPng} ${Buffer.from(b64, "base64").length} bytes`);
  } else {
    console.log(`[eval] ${JSON.stringify(v)}`);
  }
  await sleep(Number(arg("evalWait", "4200")));
}

if (drag) {
  const [dx, dy] = drag.split(",").map(Number);
  const cx = width / 2;
  const cy = height / 2;
  const steps = 14;
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: cx,
    y: cy,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  for (let i = 1; i <= steps; i++) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: cx + (dx * i) / steps,
      y: cy + (dy * i) / steps,
      button: "left",
      buttons: 1,
    });
    await sleep(24);
  }
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: cx + dx,
    y: cy + dy,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await sleep(Number(arg("dragWait", "1600")));
}

/**
 * --move x,y / --click x,y：在指定坐标上移动 / 点击。
 *
 * `--drag` 只能从画面正中开始，而三维视图（知识库的 Token 关系链、孪生页）
 * 既不铺满整页、又必须靠指针拾取才有反应 —— 没有指定坐标的指针事件，
 * 就只能靠肉眼猜「点上去到底有没有用」。
 */
const move = arg("move", "");
if (move) {
  const [mx, my] = move.split(",").map(Number);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: mx, y: my, button: "none", buttons: 0 });
  await sleep(Number(arg("moveWait", "1200")));
}

const click = arg("click", "");
if (click) {
  const [kx, ky] = click.split(",").map(Number);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: kx, y: ky, button: "none", buttons: 0 });
  await sleep(400);
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: kx,
    y: ky,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await sleep(80);
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: kx,
    y: ky,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await sleep(Number(arg("clickWait", "1400")));
}

if (evalAfter) {
  const v = await evaluate(evalAfter);
  console.log(`[evalAfter] ${JSON.stringify(v)}`);
  await sleep(Number(arg("evalAfterWait", "1200")));
}

/**
 * --wheel <deltaY[,x,y]>：滚轮缩放地图（OrbitControls 认 wheel 事件）。
 * 负值拉近。用来在截图里放大局部，确认点位分布与标签是否重叠。
 */
const wheel = arg("wheel", "");
if (wheel) {
  const [deltaY, wx = String(width / 2), wy = String(height / 2)] = wheel.split(",").map(Number);
  const count = Number(arg("wheelCount", "6"));
  for (let i = 0; i < count; i++) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: wx,
      y: wy,
      deltaX: 0,
      deltaY,
      button: "none",
      buttons: 0,
    });
    await sleep(90);
  }
  await sleep(Number(arg("wheelWait", "2600")));
}

/**
 * --clip x,y,w,h：只截取这一块（CSS 像素），用来在 1920 宽的图里放大局部
 * 检查点位与标签是否重叠 —— 预览会把整图缩到 1066 宽，细节会被抹掉。
 */
const clip = arg("clip", "");
const shotParams = { format: "png", captureBeyondViewport: false };
if (clip) {
  const [cx, cy, cw, ch] = clip.split(",").map(Number);
  shotParams.clip = { x: cx, y: cy, width: cw, height: ch, scale: 1 };
}
const shot = await send("Page.captureScreenshot", shotParams);
writeFileSync(out, Buffer.from(shot.data, "base64"));

/**
 * 设计规范 §12 验收 Checklist 的可量化项：
 *   - 字号层级数（规范要求一个页面最多 5 个明显层级）
 *   - 有色边框元素占比（规范要求砍掉约 50% 亮边框）
 *   - 去重后的文字色 / 背景色 / 边框色数量（规范要求收敛到一套 token）
 *   - emoji / 装饰性彩色元素
 */
if (process.argv.includes("--audit")) {
  const audit = await evaluate(`(() => {
    const els = [...document.querySelectorAll('body *')];
    const sizes = new Map(), textColors = new Map(), bgColors = new Map(), borderColors = new Map();
    let bordered = 0, coloredBorder = 0, textNodes = 0;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const cs = getComputedStyle(el);
      const fs = Math.round(parseFloat(cs.fontSize) * 2) / 2;
      if (el.textContent && el.children.length === 0 && el.textContent.trim()) {
        textNodes++;
        sizes.set(fs, (sizes.get(fs) || 0) + 1);
        textColors.set(cs.color, (textColors.get(cs.color) || 0) + 1);
      }
      const bg = cs.backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)') bgColors.set(bg.replace(/\\s/g, ''), 1);
      const bw = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderBottomWidth) + parseFloat(cs.borderRightWidth);
      if (bw > 0 && cs.borderTopStyle !== 'none') {
        bordered++;
        const bc = cs.borderTopColor;
        const m = bc.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?/);
        // 「有色」= 有实际 alpha 且不是灰阶
        if (m && m[4] !== '0' && !(m[1] === m[2] && m[2] === m[3])) {
          coloredBorder++;
          borderColors.set(bc.replace(/\\s/g, ''), 1);
        }
      }
    }
    const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([k, v]) => k + (typeof v === 'number' && v > 1 ? '(' + v + ')' : '')).join(' ');
    return [
      'textNodes=' + textNodes,
      'fontSizes=' + sizes.size + ' -> ' + [...sizes.keys()].sort((a, b) => b - a).join('/'),
      'topFontSizes=' + top(sizes, 5),
      'bordered=' + bordered + ' coloredBorder=' + coloredBorder + ' (' + Math.round(coloredBorder / Math.max(1, bordered) * 100) + '%)',
      'textColors=' + textColors.size,
      'bgColors=' + bgColors.size,
      'borderColors=' + borderColors.size,
      'topText=' + top(textColors, 5),
      'topBg=' + top(bgColors, 6),
      'topBorder=' + top(borderColors, 5),
    ].join('\\n');
  })()`);
  console.log('--- audit ---');
  console.log(audit ?? '(no audit)');
}

// 顺带把页面上的关键尺寸打出来，方便定位布局问题
const probe = await evaluate(`(() => {
  const out = [];
  document.querySelectorAll('.ov__panel, .ov__crumb, .ov__actions, .ov__hint, .ov__foot').forEach(el => {
    const r = el.getBoundingClientRect();
    out.push(el.className + ' @ ' + [r.left, r.top, r.width, r.height].map(v => Math.round(v)).join(','));
  });
  const c = document.querySelector('canvas');
  out.push('canvas ' + (c ? [c.clientWidth, c.clientHeight].join('x') : 'none'));

  /*
   * 溢出与裁切探针。
   *
   * 放大字号之后最需要回答的问题是「有没有内容被切掉」—— 光看截图很难发现
   * 一个 322px 面板里第 6 行被 overflow:hidden 吃掉。所以分两类报：
   *   clipped = overflow:hidden 且 scrollHeight 明显大于 clientHeight（内容**看不见**，是缺陷）
   *   scrolled = overflow:auto/scroll 且可滚动（内部滚动，多数是设计如此，仅作参考）
   * 文本内容超过 2px 才算，避免亚像素抖动误报。
   */
  const clipped = [], scrolled = [];
  // SVG 内部图形（地图标注、图表描边）天生会画到容器外，不算布局缺陷，跳过
  const SVG_TAGS = new Set(['svg', 'path', 'g', 'text', 'circle', 'line', 'rect', 'polygon', 'polyline', 'defs', 'use']);
  /*
   * 外壳容器不参与判定：.page / .ov 都是 position:absolute; inset:0，
   * 它们的 scrollHeight 会把绝对定位的地图画布也算进去，于是外壳永远「溢出」，
   * 但用户什么都看不到被切。真正有意义的是面板与滚动区，那才是会吃掉内容的地方。
   */
  const SKIP_CLASSES = new Set(['appshell', 'appshell__stage']);
  for (const el of document.querySelectorAll('body *')) {
    if (SVG_TAGS.has(el.tagName.toLowerCase())) continue;
    if (typeof el.className === 'string' && SKIP_CLASSES.has(el.className.split(' ')[0])) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    const cs = getComputedStyle(el);
    const dy = el.scrollHeight - el.clientHeight;
    const dx = el.scrollWidth - el.clientWidth;
    if (dy <= 2 && dx <= 2) continue;
    const tag = (el.className && typeof el.className === 'string' ? el.className.split(' ')[0] : el.tagName);
    // 单行省略号是**有意**的截断：横向溢出正是它要的效果，不算缺陷
    const ellipsis = cs.textOverflow === 'ellipsis' && cs.whiteSpace === 'nowrap' && dy <= 2;
    if (ellipsis) continue;
    const entry = tag + '(y+' + dy + ',x+' + dx + ')';
    /*
     * 按**轴**判断，不按元素整体判断。
     * 「overflow:hidden 打底 + overflow-y:auto」是很常见的写法（dashboard.css 的
     * .tech-panel__body 加各页的一行覆盖），这时 overflowX 仍然是 hidden，
     * 但纵向内容是可以滚出来的 —— 按元素整体判会把它误报成「内容被吃掉」。
     */
    const lost = dy > 2 ? cs.overflowY === 'hidden' : cs.overflowX === 'hidden';
    if (lost) clipped.push(entry);
    else scrolled.push(entry);
  }
  out.push('clipped: ' + (clipped.length ? clipped.length + ' -> ' + clipped.slice(0, 8).join(' ') : 'none'));
  out.push('scrolled: ' + (scrolled.length ? scrolled.length + ' -> ' + scrolled.slice(0, 8).join(' ') : 'none'));
  out.push('overflow: ' + (clipped.length ? 'clipped' : scrolled.length ? 'scrolled' : 'none'));

  // 最终落在哪个路由：没有会话时 RequireLogin 会把人送到 #/login，
  // 截图看起来「有字有边框」、探针也照样出数，只有这一行能一眼看出截错了页
  out.push('hash: ' + window.location.hash);
  return out.join('\\n');
})()`);

console.log(probe ?? "(no probe)");
console.log(`--- console (${logs.length}) ---`);
console.log(logs.slice(0, 40).join("\n") || "(clean)");
console.log(`saved ${out}`);

ws.close();
chrome.kill();
process.exit(0);
