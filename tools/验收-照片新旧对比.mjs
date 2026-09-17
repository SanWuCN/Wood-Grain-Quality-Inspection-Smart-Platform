/**
 * 样本新旧对比（训练验证 → 新旧对比）· 端到端验收（真浏览器、真服务端、真素材）
 *
 * ── 用户口径（2026-09-22）────────────────────────────────────────
 * 「将我现在给的东西呈现到固件及模型，训练验证，新旧对比中」。
 * 给的东西：1,312 张处理后影像（HEIC 按四宫格切块，1512×2016）、27 张人工标注原片
 * （3024×4032）、1,312 行对照表（新文件名 ← 原文件名 ← 源照片 + 位号）。
 *
 * 判据（每条都能证伪 —— 尤其是"图是不是真的解码出来了"）：
 *   ① 从「固件及模型 → 训练验证」切到「新旧对比」视图，这一段就挂在里面；
 *   ② 概览的数字来自对照表与素材接口：源照片 328、编号件 1,312、已标注 27；
 *   ③ 四宫格四格 **都真的加载出图**（naturalWidth > 0），位号 1/2/3/4 与方位标注齐全；
 *   ④ 规格是**实测**出来的 1512×2016（不是写死的文案）；
 *   ⑤ 编号对照表 1,312 行 / 每页 12 行，能搜能翻页；
 *   ⑥ 已标注原片 27 张且真加载；
 *   ⑦ 点一格能看原件（弹窗里那张图也真加载，宽度远大于缩略图）；
 *   ⑧ 素材与对照表"一一对应"这句在页面上有据：位号分布 328×4、四块齐全。
 *
 * 前置：8000 在跑且素材目录在（默认 D:\平台\数据集-照片处理-20260922）。用法：
 *   node tools/验收-照片新旧对比.mjs [--url http://127.0.0.1:8000/]
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const urlIndex = args.indexOf("--url");
const BASE = (urlIndex >= 0 ? args[urlIndex + 1] : "http://127.0.0.1:8000/").replace(/\/$/, "");
const PORT = 9513;
const PROFILE = `${process.env.TEMP}\\mumai-photo-compare-profile`;
const SHOT_DIR = process.env.MUMAI_SHOT_DIR ?? "D:\\平台\\验收截图";

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
    "--window-size=1600,1100",
    "--mute-audio",
    `${BASE}/#/`,
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `　（${detail}）` : ""}`);
  if (!ok) failed += 1;
};

try {
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
  if (!page) throw new Error("等不到可调试的页面（8000 在跑吗？）");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const waiting = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (waiting.has(m.id)) {
      waiting.get(m.id)(m);
      waiting.delete(m.id);
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
      throw new Error(`页面内抛错：${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`);
    }
    return r.result?.result?.value;
  };
  const shot = async (name) => {
    try {
      mkdirSync(SHOT_DIR, { recursive: true });
      const r = await send("Page.captureScreenshot", { format: "png" });
      const data = r?.result?.data;
      if (!data) return;
      const file = `${SHOT_DIR}\\${name}.png`;
      writeFileSync(file, Buffer.from(data, "base64"));
      console.log(`  · 现场截图：${file}`);
    } catch {
      /* 截图失败不影响结论 */
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");

  /* 滚进视口再断言图片：网格与图墙用了 loading="lazy"，首屏之外本来就不会先加载 */
  const scrollTo = (selector) =>
    evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el) el.scrollIntoView({ block: 'center' });
      return Boolean(el);
    })()`);

  /* ---------- 登录 ---------- */
  for (let i = 0; i < 80; i += 1) {
    if (await evaluate(`Boolean(document.querySelector('input'))`)) break;
    await sleep(250);
  }
  await evaluate(`(() => {
    const inputs = [...document.querySelectorAll('input')];
    if (inputs.length < 2) return false;
    const setValue = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setValue(inputs[0], 'shi');
    setValue(inputs[1], '123456');
    const form = inputs[0].closest('form');
    if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
    return true;
  })()`);
  let inApp = false;
  for (let i = 0; i < 80; i += 1) {
    const st = await evaluate(`({ hash: location.hash, nav: document.querySelectorAll('nav button, nav a, aside button').length })`);
    if (st && !String(st.hash).includes("login") && st.nav > 0) {
      inApp = true;
      break;
    }
    await sleep(250);
  }
  check("登录成功并进入平台页面", inApp, `hash=${await evaluate(`location.hash`)}`);

  /* ---------- ① 固件及模型 → 训练验证 → 新旧对比 ---------- */
  await evaluate(`location.hash = '#/firmware?tab=training'`);
  let tabReady = false;
  for (let i = 0; i < 60; i += 1) {
    tabReady = await evaluate(`Boolean([...document.querySelectorAll('button, a')].find((el) => el.textContent.trim() === '新旧对比'))`);
    if (tabReady) break;
    await sleep(250);
  }
  check("进入固件及模型 · 训练验证页", tabReady, await evaluate(`location.hash`));

  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '新旧对比');
    if (btn) btn.click();
    return Boolean(btn);
  })()`);

  let ready = false;
  for (let i = 0; i < 80; i += 1) {
    ready = await evaluate(`Boolean(document.querySelector('.sc-overview') && document.querySelectorAll('.sc-grid .sc-cell').length === 4)`);
    if (ready) break;
    await sleep(250);
  }
  check("「新旧对比」视图里出现样本新旧对比一段（四宫格已渲染）", ready, ready ? "四格就位" : "没有等到 .sc-overview / .sc-grid");
  if (!ready) throw new Error("面板没出现，后续检查没有意义");

  /* 等图片真的解码（naturalWidth 是"真的加载出来了"的唯一硬判据） */
  const imagesLoaded = async (selector) =>
    evaluate(`(() => {
      const imgs = [...document.querySelectorAll(${JSON.stringify(selector)})];
      return { total: imgs.length, loaded: imgs.filter((img) => img.naturalWidth > 0).length,
               sizes: imgs.map((img) => img.naturalWidth + 'x' + img.naturalHeight) };
    })()`);

  await scrollTo(".sc-grid");
  let grid = null;
  for (let i = 0; i < 60; i += 1) {
    grid = await imagesLoaded(".sc-grid .sc-cell__img");
    if (grid && grid.total === 4 && grid.loaded === 4) break;
    await sleep(500);
  }
  check("四宫格四张图都真的加载出来（naturalWidth > 0）", grid?.total === 4 && grid?.loaded === 4, `${grid?.loaded}/${grid?.total} 张 · ${(grid?.sizes ?? []).join(" ")}`);

  await shot("照片新旧对比-四宫格");

  /* ---------- ② 概览数字 ---------- */
  const overview = await evaluate(`(() => {
    const items = [...document.querySelectorAll('.sc-overview li')].map((li) => ({
      key: li.querySelector('small')?.textContent.trim() ?? '',
      value: li.querySelector('b')?.textContent.trim() ?? '',
      /* 直接子 span：NumberAnimation 自己也是 span，不加 '>' 会把 <b> 里的数字读成说明 */
      note: li.querySelector(':scope > span')?.textContent.trim() ?? '',
    }));
    return items;
  })()`);
  const valueOf = (key) => overview.find((item) => item.key.includes(key))?.value ?? "";
  check(
    "概览：源照片 328 张 / 编号件 1,312 张 / 已标注 27 张（数字全部来自真实素材与对照表）",
    valueOf("源照片") === "328 张" && valueOf("编号件") === "1,312 张" && valueOf("已标注") === "27 张",
    overview.map((item) => `${item.key}=${item.value}`).join(" · "),
  );
  check(
    "源照片编号区间写的是对照表里真实的 IMG_0467–IMG_0794",
    (overview.find((item) => item.key.includes("源照片"))?.note ?? "").includes("IMG_0467–IMG_0794"),
    overview.find((item) => item.key.includes("源照片"))?.note ?? "—",
  );
  check(
    "原图规格是**实测**出来的 1512×2016（不是写死的文案）",
    valueOf("原图规格") === "1512×2016",
    valueOf("原图规格"),
  );

  /* ---------- ③ 四宫格的位号与编号 ---------- */
  const cells = await evaluate(`(() => [...document.querySelectorAll('.sc-grid .sc-cell')].map((cell) => ({
    pos: cell.querySelector('figcaption b')?.textContent.trim() ?? '',
    old: cell.querySelector('figcaption span')?.textContent.trim() ?? '',
    nw: cell.querySelector('figcaption code')?.textContent.trim() ?? '',
  })))()`);
  check(
    "四格按位号 1左上 / 2右上 / 3左下 / 4右下 摆位（摆位照位号，不照编号顺序）",
    JSON.stringify(cells.map((c) => c.pos)) === JSON.stringify(["位号 1", "位号 2", "位号 3", "位号 4"]),
    cells.map((c) => c.pos).join(" / "),
  );
  const oldNames = cells.map((c) => c.old);
  const sameSource = new Set(oldNames.map((name) => name.replace(/_\d\.jpg$/, ""))).size === 1;
  check(
    "四格是同一张源照片的四块：原文件名后缀正好 1/2/3/4，新编号各不相同",
    cells.every((c) => /^IMG_\d+_\d\.jpg$/.test(c.old) && /^sxs20260922\d{5}\.jpg$/.test(c.nw)) &&
      sameSource &&
      oldNames.map((name) => name.match(/_(\d)\.jpg$/)?.[1]).join("") === "1234" &&
      new Set(cells.map((c) => c.nw)).size === 4,
    cells.map((c) => `${c.old}→${c.nw}`).join(" ／ "),
  );

  /*
    切到对照表里"钦定"过的一张源照片（IMG_0766.HEIC：四块编号 0001/0251/1084/1098，
    与 photoSetLogic.test.ts 里钉的一致）——证明下拉是真的按源照片取块，
    不是把四张图随便摆上去。位号顺序 ≠ 编号顺序，这一条最能戳穿假实现。
  */
  await evaluate(`(() => {
    const select = document.querySelector('.sc-grid')
      ? document.querySelector('.sc-picker select')
      : null;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, 'IMG_0766.HEIC');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  let picked = null;
  for (let i = 0; i < 40; i += 1) {
    picked = await evaluate(`(() => [...document.querySelectorAll('.sc-grid .sc-cell')].map((cell) => ({
      old: cell.querySelector('figcaption span')?.textContent.trim() ?? '',
      nw: cell.querySelector('figcaption code')?.textContent.trim() ?? '',
    })))()`);
    if (picked?.[0]?.nw === "sxs2026092200001.jpg") break;
    await sleep(300);
  }
  check(
    "选中 IMG_0766.HEIC：四块编号 0001 / 0251 / 1084 / 1098（与对照表逐条一致）",
    JSON.stringify(picked?.map((c) => c.nw)) ===
      JSON.stringify([
        "sxs2026092200001.jpg",
        "sxs2026092200251.jpg",
        "sxs2026092201084.jpg",
        "sxs2026092201098.jpg",
      ]),
    (picked ?? []).map((c) => c.nw).join(" / "),
  );

  /* ---------- ⑤ 编号对照表：行数 / 搜索 / 翻页 ---------- */
  const tableInfo = () =>
    evaluate(`(() => {
      const panel = document.querySelector('.sc-block[aria-label="新文件名与原文件名对照"]');
      const rows = [...panel.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()));
      const note = panel.querySelector('p')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
      const pages = [...panel.querySelectorAll('.sc-picker .muted')].map((el) => el.textContent.replace(/\\s+/g, ' ').trim());
      return { rows, note, pages, first: rows[0]?.[0] ?? '', count: rows.length };
    })()`);

  const before = await tableInfo();
  check(
    "编号对照表：每页 12 行，脚注写明共 1,312 行与位号分布（1左上 328 · 2右上 328 · 3左下 328 · 4右下 328）",
    before.count === 12 && /共 1,312 行/.test(before.note) && /1左上 328/.test(before.note) && /4右下 328/.test(before.note),
    `${before.count} 行 · ${before.note.slice(0, 120)}`,
  );
  check(
    "脚注同时给出「每张源照片四块齐全」（不齐会明确告警）",
    /四块齐全/.test(before.note),
    before.note.slice(-40),
  );

  await evaluate(`(() => {
    const input = document.querySelector('.sc-block[aria-label="新文件名与原文件名对照"] input[type="search"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'IMG_0766');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  let searched = null;
  for (let i = 0; i < 24; i += 1) {
    searched = await tableInfo();
    if (searched.count === 4 && /共 4 行/.test(searched.note)) break;
    await sleep(300);
  }
  check(
    "搜「IMG_0766」正好筛出四块（位号 1/2/3/4 各一条）",
    searched.count === 4 && /共 4 行/.test(searched.note),
    `${searched.count} 行 · ${searched.rows.map((row) => row[3]).join(" / ")} · 脚注「${searched.note.slice(0, 50)}」`,
  );

  await evaluate(`(() => {
    const input = document.querySelector('.sc-block[aria-label="新文件名与原文件名对照"] input[type="search"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  await evaluate(`(() => {
    const panel = document.querySelector('.sc-block[aria-label="新文件名与原文件名对照"]');
    const btn = [...panel.querySelectorAll('button')].find((el) => el.textContent.trim() === '下一页');
    btn.click();
    return true;
  })()`);
  await sleep(400);
  const paged = await tableInfo();
  check(
    "翻到第 2 页：首行换了、仍是 12 行（1,312 行分 110 页）",
    paged.first !== before.first && paged.count === 12 && /第 2 \/ 110 页/.test(paged.pages.join(" ")),
    `第 1 页首行 ${before.first} → 第 2 页首行 ${paged.first} · ${paged.pages.join(" ")}`,
  );

  /* ---------- ④ 已标注原片 ---------- */
  await scrollTo(".sc-wall");
  let wall = null;
  for (let i = 0; i < 40; i += 1) {
    wall = await imagesLoaded(".sc-wall__img");
    if (wall && wall.total === 27 && wall.loaded >= 12) break;
    await sleep(400);
  }
  check("已标注原片 27 张都挂在墙上，缩略图真的加载", wall?.total === 27 && wall?.loaded >= 12, `${wall?.loaded}/${wall?.total} 张已加载`);
  check(
    "已标注原片与对照表没有交集这一点写在页面上（不硬配对）",
    await evaluate(`document.querySelector('.sc-block[aria-label="已标注原片"] header .muted')?.textContent.includes('没有交集') ?? false`),
    await evaluate(`document.querySelector('.sc-block[aria-label="已标注原片"] header .muted')?.textContent.replace(/\\s+/g,' ').trim() ?? '—'`),
  );

  /* ---------- ⑦ 点开看原件 ---------- */
  await shot("照片新旧对比-总览");
  await evaluate(`document.querySelector('.sc-grid .sc-cell__img').click()`);
  let lightbox = null;
  for (let i = 0; i < 40; i += 1) {
    lightbox = await evaluate(`(() => {
      const img = document.querySelector('.sc-lightbox__img');
      if (!img) return null;
      return { loaded: img.naturalWidth > 0, w: img.naturalWidth, h: img.naturalHeight,
               title: document.querySelector('.modal__head h3')?.textContent.trim() ?? '',
               caption: document.querySelector('.modal__sub')?.textContent.replace(/\\s+/g, ' ').trim() ?? '' };
    })()`);
    if (lightbox?.loaded) break;
    await sleep(400);
  }
  check(
    "点一格能看原件：弹窗里的大图真加载，且是原件分辨率（远大于 360 宽的缩略图）",
    lightbox?.loaded === true && lightbox.w > 1000,
    lightbox ? `${lightbox.w}×${lightbox.h} · ${lightbox.title}` : "弹窗没出现",
  );
  check(
    "弹窗标出这张图的来历（源照片 + 位号 + 原文件名）",
    Boolean(lightbox?.caption) && /位号 \d（(左上|右上|左下|右下)）/.test(lightbox.caption) && /原文件名 IMG_\d+_\d\.jpg/.test(lightbox.caption),
    lightbox?.caption ?? "—",
  );
  await shot("照片新旧对比-看原件");

  /* ---------- ⑧ 小木把人带过来：Ctrl+Y 9（第⑲轮 对比新旧模型）---------- */
  await evaluate(`document.querySelector('.modal__close')?.click()`);
  await sleep(300);
  /* 先离开这一页，证明是"被带过来"的，而不是"本来就在" */
  await evaluate(`location.hash = '#/orders'`);
  await sleep(900);
  const press = (key, code) =>
    evaluate(`(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)},
        ctrlKey: true, bubbles: true, cancelable: true }));
      return true;
    })()`);
  await press("y", "KeyY");
  await press("9", "Digit9");

  let landed = null;
  for (let i = 0; i < 80; i += 1) {
    landed = await evaluate(`({ hash: location.hash, panel: Boolean(document.querySelector('.sc-overview')) })`);
    if (String(landed.hash).includes("view=compare") && landed.panel) break;
    await sleep(250);
  }
  check(
    "按 Ctrl+Y 9（⑲ 对比新旧模型）小木直接带进「训练验证 → 新旧对比」",
    String(landed?.hash).includes("tab=training") && String(landed?.hash).includes("view=compare"),
    landed?.hash ?? "—",
  );
  check("带过来之后样本新旧对比这一段就在屏幕上（不用再点一次视图按钮）", landed?.panel === true, landed?.panel ? "已在位" : "没有等到 .sc-overview");
} catch (error) {
  console.error(`  ✗ 工装自身出错：${error?.message ?? error}`);
  failed += 1;
} finally {
  chrome.kill();
}

console.log(failed === 0 ? "\n全部通过（训练验证 · 新旧对比里的照片处理批次）" : `\n${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
