/**
 * 数字孪生 · 「关键帧带图 + 打标签」端到端验收（真浏览器、真服务端）
 *
 * ── 这一组在防什么（用户 2026-09-18 口径）────────────────────────────
 * 用户原话：「平台数字孪生的打关键帧右侧应该显示相应的图，然后我给他打标签，就是 Z01 那种，
 * 现在点击打关键帧显示会直接黑掉，不知道是跳到了什么地方」。
 * 复现结论：点「打关键帧」本身不改镜头、不改 DOM（帧也真的写进去了），黑的是 **3D 区**——
 * `SplatMesh` 的加载回调（页面据此撤掉加载覆盖层、放开按钮）只代表**文件解析完**，
 * 画面上还没有东西：实测 6.4MB 的产物解析完还要 6~10 秒才出第一帧（58MB 的 95 秒都没出画）。
 * 于是"点一下 → 帧多一行 → 画面是黑的 → 也不知道这一帧记的是哪儿"。
 *
 * 判据（每条都能证伪）：
 *   ① **从没有在"覆盖层已撤掉但画面还是黑的"时候放开过「打关键帧」**（这就是那个 bug）；
 *   ② 工具条上有「构件」选择器（Z01–Z04）：选了 Z02，地址栏与后续帧号都跟着走；
 *   ③ 打帧后右侧那一行有一张图（img，src 指服务端），点它能开大图；
 *   ④ 那张图**不是黑的**（画进 canvas 采样最亮像素 > 背景），字节来自服务端且是 image/jpeg；
 *   ⑤ 帧号前缀 = 选中的构件（标签即构件），服务端实体里带着 imageFileId（图不进实体）；
 *   ⑥ 换账号（饶）打开同一页看到同一帧同一张图；删帧后服务端两层都干净（自己清理）。
 *
 * 前置：8000 在跑（页面 + API 同一个服务）。用法：
 *   node tools/验收-关键帧带图与打标签.mjs [--url http://127.0.0.1:8000/]
 *
 * ⚠ 它会真的往演示库里写一帧 + 传一张图（跑完自己删帧）；图文件留在服务端文件库里
 *   （文件库是追加式的，没有删文件的接口），一张约 100KB。
 */
import { existsSync, rmSync } from "node:fs";

const args = process.argv.slice(2);
const urlIndex = args.indexOf("--url");
const BASE = (urlIndex >= 0 ? args[urlIndex + 1] : "http://127.0.0.1:8000/").replace(/\/$/, "");
const PORT = 9524;
const PROFILE = `${process.env.TEMP}\\mumai-keyframe-image-profile`;
/** 演示库里绑定了模型的工单（没有它这一页是空态，什么都测不了） */
const ORDER_ID = process.env.MUMAI_TWIN_ORDER ?? "SH-2026-0901";
/** 从 Z02 开始：证明"帧号跟着选中的构件走"，而不是永远 Z04/Z01 */
const COMPONENT = "Z02";
/** 与服务端/前端同一条判据：亮过它才算"画面里真有东西" */
const FRAME_BLACK_LUMA = 24;

function findChrome() {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error("找不到 Chrome / Edge");
  return hit;
}

rmSync(PROFILE, { recursive: true, force: true });
const { spawn } = await import("node:child_process");
const chrome = spawn(
  findChrome(),
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    /* 高斯泼溅要 WebGL：无头环境用 SwiftShader 软件渲染（慢，但能出画面） */
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
    "--window-size=1440,900",
    "--mute-audio",
    `${BASE}/#/twin?order=${ORDER_ID}`,
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `　（${detail}）` : ""}`);
  if (!ok) failed += 1;
};

/** 服务端直查（不靠页面自证）：实体里到底存了什么 */
async function serverScene(account = "shi") {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account, password: "123456" }),
  });
  const { token } = await login.json();
  const snapshot = await (
    await fetch(`${BASE}/api/sessions/demo-01/snapshot`, { headers: { authorization: `Bearer ${token}` } })
  ).json();
  const scene = (snapshot.entities?.scene ?? []).find((item) => item.data?.orderId === ORDER_ID);
  return {
    sceneId: scene?.id ?? null,
    revision: scene?.revision ?? null,
    frames: scene?.data?.keyframes ?? [],
    bookmarks: scene?.data?.bookmarkIds ?? [],
    token,
  };
}

async function command(token, body) {
  const response = await fetch(`${BASE}/api/commands`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "demo-01", ...body }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

let page = null;
for (let i = 0; i < 120; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl && t.url.startsWith(BASE));
    if (page) break;
  } catch {
    /* 还没起来 */
  }
  await sleep(250);
}
if (!page) {
  chrome.kill();
  throw new Error(`等不到可调试的页面（${BASE} 在跑吗？）`);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const waiting = new Map();
const consoleErrors = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)(m);
    waiting.delete(m.id);
    return;
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? a.type).join(" ").slice(0, 200));
  }
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    consoleErrors.push(`[exception] ${d.text ?? ""} ${d.exception?.description ?? ""}`.slice(0, 200));
  }
});
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    waiting.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) {
    const detail = r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text ?? "?";
    throw new Error(`页面内抛错：${detail}`);
  }
  return r.result?.result?.value;
};
await send("Page.enable");
await send("Runtime.enable");

/**
 * 画面亮度：**只看 canvas 自己的像素**（`drawImage` 不含任何 DOM 覆盖层），
 * 而且读的是**正中 1:1 的一块**。
 *
 * ⚠ 别改成"缩到 32×20 再看最亮值"：默认双线性缩放在 33 像素一步的采样里
 * 会把细高的木柱整个跳过去，读出来永远是背景色 9 —— 同一块画布三种读法实测：
 * `32×20 默认`=9（假黑）、`¼ + imageSmoothingQuality:"high"`=219、`中心 1:1`=230。
 * 这个坑正是"按钮一直等不到出画"的原因，工装必须用与页面探测**同一条读法**。
 */
const canvasLuma = () =>
  evaluate(`(() => {
    const canvas = document.querySelector('.splat-stage canvas') || document.querySelector('canvas');
    if (!canvas || canvas.width < 8) return null;
    const w = Math.min(360, canvas.width);
    const h = Math.min(240, canvas.height);
    const sx = Math.floor((canvas.width - w) / 2);
    const sy = Math.floor((canvas.height - h) / 2);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(canvas, sx, sy, w, h, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    let max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
      if (v > max) max = v;
    }
    return max;
  })()`);

const buttonState = () =>
  evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim().startsWith('打关键帧'));
    return btn
      ? { found: true, disabled: btn.disabled, title: (btn.title || '').slice(0, 60) }
      : { found: false };
  })()`);

const pageState = () =>
  evaluate(`(() => ({
    hash: location.hash,
    overlay: Boolean(document.querySelector('.splat-stage__load')),
    rows: [...document.querySelectorAll('.keyframe-list li')].map((li) => ({
      id: (li.querySelector('.keyframe-list__id')?.textContent || '').trim(),
      meta: (li.querySelector('.keyframe-list__meta')?.textContent || '').trim(),
      img: li.querySelector('.keyframe-list__shot img')?.getAttribute('src') || null,
      alt: li.querySelector('.keyframe-list__shot img')?.getAttribute('alt') || null,
    })),
    componentOptions: [...document.querySelectorAll('select[aria-label*="构件"] option')].map((o) => o.value),
    componentValue: document.querySelector('select[aria-label*="构件"]')?.value ?? null,
  }))()`);

try {
  /* ---------- 登录（史）并进孪生页 ---------- */
  let loginReady = false;
  for (let i = 0; i < 240; i += 1) {
    if (await evaluate(`document.querySelectorAll('input').length >= 2`)) {
      loginReady = true;
      break;
    }
    await sleep(250);
  }
  if (!loginReady) throw new Error("等不到登录框");
  await evaluate(`(() => {
    const inputs = [...document.querySelectorAll('input')];
    const setValue = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setValue(inputs[0], 'shi');
    setValue(inputs[1], '123456');
    const form = inputs[0].closest('form');
    if (form) (form.requestSubmit ? form.requestSubmit() : form.submit());
    return true;
  })()`);
  for (let i = 0; i < 120; i += 1) {
    if (String(await evaluate(`location.hash`)).includes("twin")) break;
    await sleep(500);
  }
  if (!String(await evaluate(`location.hash`)).includes(`order=${ORDER_ID}`)) {
    await evaluate(`location.hash = '#/twin?order=${ORDER_ID}'`);
    await sleep(1500);
  }
  check("登录后进到数字孪生页（带工单）", String(await evaluate(`location.hash`)).includes("twin"), await evaluate(`location.hash`));

  /* ---------- ① 关键判据：黑屏期间点下去**不许写库** ---------- */
  /*
   * 采样整个加载过程：每次记下（覆盖层在不在 / 画面亮不亮 / 按钮禁不禁用 + title）。
   *
   * 为什么不是简单断言"按钮在黑屏时一定禁用"：产物可以被"兜底计时"放开
   * （`PAINT_WAIT_MS`，兜底存在的理由是软件渲染/暗产物下不能让按钮永远点不了），
   * 所以真正要守的是**下游**那条：黑屏时点下去不许记帧、并且当场说明原因 ——
   * 用户原话里的"点一下打关键帧，画面是黑的"就是这条被破了（老实现会静默写一帧黑机位）。
   */
  const samples = [];
  let lit = 0;
  let firstClickable = null;
  for (let i = 0; i < 200; i += 1) {
    const [luma, button, state] = await Promise.all([canvasLuma(), buttonState(), pageState()]);
    if (luma !== null && luma > FRAME_BLACK_LUMA) lit += 1;
    const sample = {
      luma: luma === null ? null : Math.round(luma),
      overlay: state.overlay,
      disabled: button.disabled ?? null,
      title: button.title ?? "",
    };
    samples.push(sample);
    if (button.found && button.disabled === false && !firstClickable) firstClickable = sample;
    if (button.found && button.disabled === false) break;
    await sleep(400);
  }
  const blackWhileClickable = samples.filter((s) => s.luma !== null && s.luma <= FRAME_BLACK_LUMA && s.disabled === false);

  let blockedWhileBlack = "本机没走到（放开时画面已出画）";
  if (blackWhileClickable.length) {
    /* 画面还黑着但按钮可点：点一下，必须**不写库**且把原因说出来 */
    const serverBeforeRefuse = await serverScene("shi");
    await evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim().startsWith('打关键帧'));
      btn.click();
      return true;
    })()`);
    await sleep(2500);
    const serverAfterRefuse = await serverScene("shi");
    const said = await evaluate(`(document.querySelector('.appshell__toasts')?.textContent || '').trim()`);
    blockedWhileBlack =
      serverAfterRefuse.frames.length === serverBeforeRefuse.frames.length && /黑|没有记帧/.test(said)
        ? `拦住了（帧数 ${serverBeforeRefuse.frames.length} 未变，提示「${said.slice(0, 40)}」）`
        : `没拦住！帧数 ${serverBeforeRefuse.frames.length} → ${serverAfterRefuse.frames.length}，提示「${said.slice(0, 40)}」`;
  }
  check(
    "① 画面还黑着的时候点「打关键帧」：不写库，并说明原因（不会再记下黑帧）",
    typeof blockedWhileBlack === "string" && blockedWhileBlack.startsWith("拦") ? true : blockedWhileBlack.startsWith("本机"),
    blockedWhileBlack,
  );
  check(
    "①b 只要画面出画了，按钮就是可点的",
    Boolean(firstClickable),
    firstClickable ? `第一次可点：${JSON.stringify(firstClickable)}` : `采样 ${samples.length} 次都没等到可点`,
  );

  /* ---------- ①c 等画面真的出画（软件渲染下可能很慢；这一步之后的判据才有意义）---------- */
  let peak = 0;
  for (let i = 0; i < 150; i += 1) {
    const luma = await canvasLuma();
    if (typeof luma === "number" && luma > peak) peak = luma;
    if (typeof luma === "number" && luma > FRAME_BLACK_LUMA) break;
    await sleep(1200);
  }
  check(
    "①c 3D 画面真的画出来了（打帧才不会存一张黑图）",
    peak > FRAME_BLACK_LUMA,
    `最亮像素=${Math.round(peak)}（阈值 ${FRAME_BLACK_LUMA}，采样 ${samples.length} 次里亮过 ${lit} 次）`,
  );

  /* ---------- ③ 构件选择器 = 这一帧的标签 ---------- */
  const before = await pageState();
  check(
    "② 工具条上有「构件」选择器（Z01–Z04）",
    ["Z01", "Z02", "Z03", "Z04"].every((z) => before.componentOptions.includes(z)),
    `选项=${JSON.stringify(before.componentOptions)}`,
  );
  await evaluate(`(() => {
    const select = document.querySelector('select[aria-label*="构件"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, ${JSON.stringify(COMPONENT)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(1200);
  const picked = await pageState();
  check(
    `②b 选 ${COMPONENT} 之后地址栏与选择框都跟着走`,
    picked.componentValue === COMPONENT && String(picked.hash).includes(`component=${COMPONENT}`),
    `hash=${picked.hash}`,
  );

  /* ---------- ③ 打帧：帧号前缀 = 构件，行内带图 ---------- */
  /*
   * ⚠ 演示会话是**共享**的：另一个账号（或另一台机器上的工装）可能正在同一个场景上打帧/删帧，
   * 那会让页面上那份 `expectedRevision` 过期 → 服务端 409（现场表现"点了没反应"）。
   * 所以这里读一次提示、最多重试 3 次：页面随事件刷新实体会带上新 revision，重试就能成。
   * 每次都把提示原文记下来，失败时看得出是"被拦（画面黑）"还是"冲突"。
   */
  const serverBefore = await serverScene("shi");
  const beforeCount = serverBefore.frames.length;
  const attempts = [];
  let after = await pageState();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim().startsWith('打关键帧'));
      btn.click();
      return true;
    })()`);
    for (let i = 0; i < 40; i += 1) {
      after = await pageState();
      if (after.rows.length > beforeCount) break;
      await sleep(500);
    }
    const said = await evaluate(`(document.querySelector('.appshell__toasts')?.textContent || '').trim()`);
    attempts.push(`第${attempt}次→行数${after.rows.length}${said ? `「${said.slice(0, 36)}」` : ""}`);
    if (after.rows.length > beforeCount) break;
    await sleep(1500);
  }
  check(
    "③ 打帧后右侧多出一行",
    after.rows.length === beforeCount + 1,
    `行数 ${beforeCount} → ${after.rows.length}　${attempts.join(" ｜ ")}`,
  );
  const row = after.rows[after.rows.length - 1] ?? { id: "", meta: "", img: null };
  check(`③b 帧号前缀就是选中的构件（${COMPONENT}）`, String(row.id).startsWith(`KF-${COMPONENT}-`), `帧号=${row.id}`);
  check(`③c 那一行的标签里有构件号（打的就是这个标签）`, String(row.meta).includes(COMPONENT), `标签行=${row.meta}`);
  check("③d 这一行带图（img 指向服务端文件）", Boolean(row.img && row.img.includes("/api/files/")), String(row.img));

  /* ---------- ④ 这张图不是黑的、字节来自服务端 ---------- */
  const imageCheck = row.img
    ? await evaluate(`(async () => {
        const img = new Image();
        img.src = ${JSON.stringify(row.img)};
        await img.decode();
        const c = document.createElement('canvas');
        c.width = 64; c.height = 40;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, 64, 40);
        const d = ctx.getImageData(0, 0, 64, 40).data;
        let max = 0;
        for (let i = 0; i < d.length; i += 4) {
          const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
          if (v > max) max = v;
        }
        const response = await fetch(${JSON.stringify(row.img)});
        const blob = await response.blob();
        return { max: Math.round(max), status: response.status, type: blob.type, kb: Math.round(blob.size / 1024) };
      })()`)
    : null;
  check(
    "④ 行内那张图**不是黑的**（画进 canvas 采样，亮过背景）",
    Boolean(imageCheck && imageCheck.max > FRAME_BLACK_LUMA),
    imageCheck ? `最亮像素=${imageCheck.max}（阈值 ${FRAME_BLACK_LUMA}）` : "没有图可测",
  );
  check(
    "④b 图真的从服务端取到字节（JPEG、体积合理）",
    Boolean(imageCheck && imageCheck.status === 200 && imageCheck.type.startsWith("image/") && imageCheck.kb >= 2),
    imageCheck ? `HTTP ${imageCheck.status} ${imageCheck.type} ${imageCheck.kb}KB` : "没有图可测",
  );

  /* ---------- ⑤ 服务端：帧上带 imageFileId，图不进实体 ---------- */
  const serverAfter = await serverScene("shi");
  const stored = serverAfter.frames.find((item) => item.id === row.id);
  check("⑤ 服务端实体里有这一帧", Boolean(stored), `帧数=${serverAfter.frames.length}`);
  check("⑤b 帧上存的是 imageFileId（图走文件库）", Boolean(stored?.imageFileId), `imageFileId=${stored?.imageFileId ?? "（空）"} imageName=${stored?.imageName ?? "（空）"}`);
  check(
    "⑤c 图**不进实体**（快照每台端都要收一遍，塞进去等于每次刷新重传所有图）",
    Boolean(stored) && !Object.keys(stored).some((key) => /base64|dataUrl/i.test(key)),
    `帧字段=${stored ? Object.keys(stored).join(",") : "—"}`,
  );

  /* ---------- ⑥ 换账号看得到；点缩略图开大图 ---------- */
  await evaluate(`(() => {
    const shot = document.querySelector('.keyframe-list li:last-child .keyframe-list__shot');
    shot.click();
    return true;
  })()`);
  await sleep(800);
  const modal = await evaluate(`(() => {
    const img = document.querySelector('.keyframe-shot-full');
    return img ? { src: img.getAttribute('src'), alt: img.getAttribute('alt') } : null;
  })()`);
  check("⑥ 点缩略图能开大图（弹窗里是同一张图）", Boolean(modal && modal.src === row.img), modal ? `alt=${modal.alt}` : "没开出弹窗");
  if (modal) await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find((el)=>(el.textContent||'').trim()==='关闭'); if(b) b.click(); return true; })()`);
  const other = await serverScene("rao");
  const seenByOther = other.frames.find((item) => item.id === row.id);
  check(
    "⑥b 换账号（饶）打开同一工单看到同一帧、同一张图",
    Boolean(seenByOther?.imageFileId) && seenByOther.imageFileId === stored?.imageFileId,
    `饶看到的 imageFileId=${seenByOther?.imageFileId ?? "（空）"}`,
  );

  /* ---------- ⑦ 清理：删掉这一帧（图文件留在文件库，追加式没有删接口） ---------- */
  const removed = await command(serverAfter.token, {
    commandId: `kf-image-cleanup-${Date.now()}`,
    action: "scene.keyframe.remove",
    entityId: serverAfter.sceneId,
    expectedRevision: serverAfter.revision,
    payload: { keyframeId: row.id },
  });
  const final = await serverScene("shi");
  check(
    "⑦ 跑完自己清干净（帧与书签两层都没有了）",
    removed.status === 200 && final.frames.length === beforeCount && !final.bookmarks.includes(row.id),
    `剩余帧=${final.frames.length}（跑之前 ${beforeCount}）`,
  );

  console.log(`\n控制台 error：${consoleErrors.length ? consoleErrors.slice(-5).join(" | ") : "无"}`);
  console.log(failed ? `\n✗ ${failed} 条判据不通过` : "\n✓ 全部判据通过");
} catch (error) {
  console.log(`\n✗ 跑挂了：${error?.message ?? error}`);
  failed += 1;
} finally {
  ws.close();
  chrome.kill();
  process.exitCode = failed ? 1 : 0;
}
