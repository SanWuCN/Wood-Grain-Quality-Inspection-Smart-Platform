/**
 * 数字孪生 · 机位关键帧 + 雷达回波频谱 端到端验收（真浏览器、真服务端）
 *
 * 覆盖两条线：
 *   A. 机位关键帧（用户 2026-09-17：「我把视角拉近木柱，然后可以打上关键帧」）；
 *   B. 波形面板（用户 2026-09-18：「数字孪生的雷达回波频谱真实些」）——
 *      同一批次要给**时域回波 + 它的频谱**两块、横轴是真实单位（ns / MHz）、
 *      图下有天线参数小字，且**不许出现深度/mm**（平台口径：不预画深度）。
 *
 * ── 用户口径（2026-09-17）────────────────────────────────────────
 * 「数字孪生那要加个操作点，添加打关键帧的功能，我把视角拉近木柱，然后可以打上关键帧」，
 * 以及「所有服务都要让别人也能用，除了本地语音识别」—— 所以这一组要同时证明：
 *   · 页面上真有这个操作点，按一下就把**当前机位**记下来；
 *   · 记下来的帧点一下能把镜头**带回那个机位**（不是只多了一行字）；
 *   · 帧存在**服务端**：换一个账号（饶）打开同一个工单，看到的是同一帧；
 *   · 删掉之后两边都没有了（跑完不留垃圾，演示库保持干净）。
 *
 * 判据（每条都能证伪）：
 *   ① 模型就绪后「打关键帧」按钮可点（没模型时是置灰的，见按钮 title）；
 *   ② 动一下镜头（滚轮推拉）→ 机位读数**变了**（读数含位置，平移也看得见）；
 *   ③ 打帧 → 列表多一行 `KF-Z04-NN`，且这一行的角度读数就是刚才那个机位；
 *   ④ 点「适应视图」把镜头带走 → 点那一行 → 读数**回到**打帧时的值，并标出「已回到该机位」；
 *   ⑤ 饶（另一个账号）打开同一页能看到 `KF-Z04-NN`（服务端共享，不是本机 localStorage）；
 *   ⑥ 删除 → 列表清空，服务端实体里也没有了（两段式删除：第一下只是举起来）。
 *
 * 「打关键帧功能还需优化」（2026-09-18）之后补的判据：
 *   ⑦ 每一行有「改名 / 更新机位 / 删除」三个操作点，并给出方位、位置两行读数；
 *     改名换名字不动帧号，行上标出「改于谁、什么时候」；
 *   ⑧ 「按顺序巡场」给出控制条（第 n/N 帧 + 上一帧/暂停/下一帧/结束巡场），当前帧在列表里高亮；
 *     点「下一帧」走到第 2 帧并转为暂停（人在控节奏）；自己动镜头高亮要清掉（原来会一直挂着骗人）；
 *   ⑨ 巡场要两个机位才成立，所以本工装不够就当场补打一帧，跑完连同 ③ 那一帧一起删掉。
 *
 * 前置：8000 在跑（页面 + API 同一个服务）。用法：
 *   node tools/验收-数字孪生打关键帧.mjs [--url http://127.0.0.1:8000/]
 */
import { existsSync, rmSync } from "node:fs";

const args = process.argv.slice(2);
const urlIndex = args.indexOf("--url");
const BASE = (urlIndex >= 0 ? args[urlIndex + 1] : "http://127.0.0.1:8000/").replace(/\/$/, "");
const PORT = 9505;
const PROFILE = `${process.env.TEMP}\\mumai-twin-keyframe-profile`;
/** 演示库里绑定了模型的工单（`/twin?order=…`；没有它就是空态，什么都测不了） */
const ORDER_ID = process.env.MUMAI_TWIN_ORDER ?? "SH-2026-0901";

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
    /* 高斯泼溅要 WebGL：无头环境用 SwiftShader 软件渲染（高模会慢，但能出画面） */
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

/** 服务端直查（用账号登录，看实体里到底存了什么）——⑤⑥ 用它，不靠页面自证 */
async function serverKeyframes(account = "shi") {
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
    frames: scene?.data?.keyframes ?? [],
    bookmarks: scene?.data?.bookmarkIds ?? [],
    token,
  };
}

try {
  /* ---------- 连页面 ---------- */
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
    if (r.result?.exceptionDetails) throw new Error(`页面内抛错：${r.result.exceptionDetails.text ?? ""}`);
    return r.result?.result?.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");

  const login = async (account) => {
    for (let i = 0; i < 80; i += 1) {
      if (await evaluate(`Boolean(document.querySelector('input'))`)) break;
      await sleep(250);
    }
    await evaluate(`(() => {
      const inputs = [...document.querySelectorAll('input')];
      const setValue = (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setValue(inputs[0], ${JSON.stringify(account)});
      setValue(inputs[1], '123456');
      const form = inputs[0].closest('form');
      if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
      return true;
    })()`);
  };

  /* ---------- 登录（史）并进孪生页 ---------- */
  await login("shi");
  for (let i = 0; i < 80; i += 1) {
    const hash = await evaluate(`location.hash`);
    if (String(hash).includes("twin")) break;
    await sleep(500);
  }
  check("登录后进到数字孪生页", String(await evaluate(`location.hash`)).includes("twin"), `hash=${await evaluate(`location.hash`)}`);

  /* ---------- ① 模型就绪 → 「打关键帧」可点 ---------- */
  const buttonState = `(() => {
    const btn = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim().startsWith('打关键帧'));
    return btn ? { found: true, disabled: btn.disabled, title: btn.title || '' } : { found: false };
  })()`;
  let ready = { found: false };
  for (let i = 0; i < 240; i += 1) {
    ready = await evaluate(buttonState);
    if (ready?.found && ready.disabled === false) break;
    await sleep(500);
  }
  check(
    "工具条上有「打关键帧」操作点，模型就绪后可点",
    Boolean(ready?.found) && ready.disabled === false,
    ready?.found ? `disabled=${ready.disabled}　title=${String(ready.title).slice(0, 40)}` : "按钮不存在",
  );
  if (!ready?.found) throw new Error("页面上没有「打关键帧」按钮，后面的判定没有意义");

  const readPose = () => evaluate(`(document.querySelector('.splat-stage__pose b')?.textContent || '').trim()`);
  const readRows = () =>
    evaluate(`(() => [...document.querySelectorAll('.keyframe-list li')].map((li) => ({
      id: (li.querySelector('.keyframe-list__id')?.textContent || '').trim(),
      meta: (li.querySelector('.keyframe-list__meta')?.textContent || '').trim(),
      pose: (li.querySelector('.keyframe-list__pose')?.textContent || '').trim(),
      fly: (li.querySelector('.keyframe-list__main')?.textContent || '').trim(),
    })))()`);

  /* ---------- ② 动一下镜头（滚轮推拉）：读数要跟着变 ---------- */
  const beforePose = await readPose();
  /** 画面指纹：用来分清"镜头真的动了但读数没刷新"和"镜头压根没动" */
  const frameSignature = async () => {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    const data = shot.result?.data ?? "";
    let hash = 0;
    for (let i = 0; i < data.length; i += 97) hash = (hash * 31 + data.charCodeAt(i)) % 2147483647;
    return { len: data.length, hash };
  };
  const beforeFrame = await frameSignature();
  /*
    推镜头有两条路，先试页面内的合成滚轮，不行再用 CDP 的真实滚轮：
      · 合成 `WheelEvent` 不依赖窗口焦点，但它**必须**命中渲染画布上的监听器；
      · CDP `Input.dispatchMouseEvent` 走真实输入通道（与手滚一样），
        但窗口不在前台时可能送不进渲染进程。
    两条都试、谁先让读数变了就算数 —— 这一步的目的是"把镜头挪开"，
    好让后面的"回到那一帧"有意义，所以不该因为输入通道的脾气而假红。
  */
  const canvasInfo = await evaluate(`(() => {
    const stages = document.querySelectorAll('.splat-stage').length;
    const canvases = [...document.querySelectorAll('.splat-stage canvas')];
    const canvas = canvases[0] ?? null;
    if (!canvas) return { stages, canvases: 0, cancelled: null };
    let cancelled = null;
    for (let i = 0; i < 8; i += 1) {
      cancelled = canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -420, bubbles: true, cancelable: true }));
    }
    return { stages, canvases: canvases.length, cancelled };
  })()`);
  let movedPose = beforePose;
  for (let i = 0; i < 24; i += 1) {
    movedPose = await readPose();
    if (movedPose && movedPose !== beforePose) break;
    await sleep(250);
  }
  if (movedPose === beforePose) {
    /* 合成滚轮没生效：改用真实滚轮 */
    const box = await evaluate(`(() => {
      const canvas = document.querySelector('.splat-stage canvas');
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`);
    if (box) {
      for (let i = 0; i < 4; i += 1) {
        await send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: box.x,
          y: box.y,
          deltaX: 0,
          deltaY: -240,
        });
        await sleep(120);
      }
      for (let i = 0; i < 24; i += 1) {
        movedPose = await readPose();
        if (movedPose && movedPose !== beforePose) break;
        await sleep(250);
      }
    }
  }
  let walkedPose = movedPose;
  if (movedPose === beforePose) {
    /* 滚轮都不行：用键盘走两步（WASD 是页面自己的移动方式，走的是 useFrame 那条路） */
    await evaluate(`(() => {
      for (const code of ['KeyW']) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code, key: 'w', bubbles: true, cancelable: true }));
      }
      return true;
    })()`);
    for (let i = 0; i < 24; i += 1) {
      walkedPose = await readPose();
      if (walkedPose && walkedPose !== beforePose) break;
      await sleep(250);
    }
    await evaluate(`(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true }));
      return true;
    })()`);
    if (walkedPose !== beforePose) movedPose = walkedPose;
  }
  /* 诊断信息：万一三条路都动不了镜头，这一行要能说清现场长什么样 */
  const sceneState = await evaluate(`(() => ({
    loading: Boolean(document.querySelector('.splat-stage__load')),
    error: (document.querySelector('.twin-model-empty.is-error')?.textContent || '').trim().slice(0, 60),
    empty: Boolean(document.querySelector('.twin-model-empty')),
    readout: (document.querySelector('.twin-readout')?.textContent || '').trim().slice(0, 80),
  }))()`);
  const afterFrame = await frameSignature();
  const pictureMoved = afterFrame.hash !== beforeFrame.hash || afterFrame.len !== beforeFrame.len;
  check(
    "推拉/走动之后机位读数确实变了（读数含位置，平移也看得见）",
    Boolean(movedPose) && movedPose !== beforePose,
    `画布 ${canvasInfo?.stages ?? "?"} 个舞台 / ${canvasInfo?.canvases ?? "?"} 个画布，合成滚轮被 preventDefault=${canvasInfo?.cancelled === false}；` +
      `「${beforePose || "（空）"}」 → 「${movedPose || "（空）"}」；` +
      `画面${pictureMoved ? "变了" : "没变"}（指纹 ${beforeFrame.hash}/${beforeFrame.len} → ${afterFrame.hash}/${afterFrame.len}）；` +
      `加载中=${sceneState?.loading} 错误态=${sceneState?.error || "无"} 空态=${sceneState?.empty}`,
  );

  /* ---------- ③ 打帧：列表多一行，且这一行就是刚才那个机位 ---------- */
  const before = await readRows();
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim().startsWith('打关键帧'));
    if (btn) btn.click();
    return true;
  })()`);
  let rows = before;
  for (let i = 0; i < 60; i += 1) {
    rows = await readRows();
    if (rows.length > before.length) break;
    await sleep(400);
  }
  const recorded = rows[rows.length - 1] ?? null;
  const poseValues = (movedPose.match(/方位\s*(-?\d+)°\s*·\s*仰角\s*(-?\d+)°\s*·\s*([\d.]+)\s*m/) ?? []).slice(1);
  check("打帧之后列表里多了一行", rows.length === before.length + 1, `${before.length} → ${rows.length}`);
  check(
    "这一行按构件编号（KF-Z04-NN），并记下是谁、什么时候打的",
    /^KF-Z04-\d{2}$/.test(String(recorded?.id ?? "")),
    `id=${recorded?.id ?? "（无）"}　meta=${recorded?.meta ?? ""}`,
  );
  check(
    "这一行的机位就是刚才那个机位（角度读数对得上）",
    Boolean(recorded?.pose) && poseValues.length === 3 && recorded.pose.includes(`方位 ${poseValues[0]}°`) && recorded.pose.includes(`仰角 ${poseValues[1]}°`),
    `行内=「${recorded?.pose ?? ""}」　当时的读数=「${movedPose}」`,
  );

  /* ---------- ④ 把镜头带走 → 点那一行 → 回到打帧时的机位 ---------- */
  const beforeFitFrame = await frameSignature();
  const fitClicked = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim().startsWith('适应视图'));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  let fitPose = movedPose;
  for (let i = 0; i < 32; i += 1) {
    fitPose = await readPose();
    if (fitPose && fitPose !== movedPose) break;
    await sleep(250);
  }
  const afterFitFrame = await frameSignature();
  const fitMovedPicture = afterFitFrame.hash !== beforeFitFrame.hash || afterFitFrame.len !== beforeFitFrame.len;
  check(
    "「适应视图」把镜头搬回取景位（读数或画面至少有一处能证明它真的动了）",
    fitClicked && (fitPose !== movedPose || fitMovedPicture),
    `按钮命中=${fitClicked}　读数${fitPose === movedPose ? "没变" : "变了"}　画面${fitMovedPicture ? "变了" : "没变"}　「${fitPose}」`,
  );
  /*
    如果「适应视图」没能把镜头搬走，就反着滚一轮 —— 这一步的目的只是"让镜头离开刚才那个机位"，
    好让"点一行回到那一帧"有意义；哪种方式搬走的都算，但判据里要写清是哪种。
  */
  let movedAwayBy = fitPose !== movedPose ? "适应视图" : "";
  if (!movedAwayBy) {
    await evaluate(`(() => {
      const canvas = document.querySelector('.splat-stage canvas');
      if (!canvas) return false;
      for (let i = 0; i < 10; i += 1) {
        canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 520, bubbles: true, cancelable: true }));
      }
      return true;
    })()`);
    for (let i = 0; i < 32; i += 1) {
      fitPose = await readPose();
      if (fitPose && fitPose !== movedPose) break;
      await sleep(250);
    }
    if (fitPose !== movedPose) movedAwayBy = "反向滚轮";
  }
  check(
    "镜头确实离开了刚打的那一帧（回放才有意义）",
    fitPose !== movedPose,
    `方式=${movedAwayBy || "都没搬动"}　「${fitPose}」`,
  );

  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.keyframe-list li')];
    const target = rows[rows.length - 1];
    const main = target?.querySelector('.keyframe-list__main');
    if (main) main.click();
    return true;
  })()`);
  let backPose = fitPose;
  for (let i = 0; i < 60; i += 1) {
    backPose = await readPose();
    if (backPose === movedPose) break;
    await sleep(250);
  }
  rows = await readRows();
  const backRow = rows[rows.length - 1] ?? null;
  check(
    "点这一行 → 镜头回到打帧时的机位（读数逐字对上）",
    backPose === movedPose,
    `期望「${movedPose}」　实际「${backPose}」`,
  );
  check(
    "行上标出「已回到该机位」（讲解人一眼知道回放生效了）",
    String(backRow?.fly ?? "").includes("已回到该机位"),
    `行文=「${String(backRow?.fly ?? "").replace(/\s+/g, " ").trim().slice(0, 60)}」`,
  );

  /* ---------- ④b 「适应视图」是可验证的：它必须回到刚进页面时的取景位 ----------
     为什么专门钉这一条：回放（我的机位）与取景（模型自带的机位）是两条独立的相机动作，
     混起来出问题时现场只会看到"镜头乱跳"。这里的判据是**页面刚打开时那个读数**
     —— 适应视图的定义就是"把镜头重新对准模型"，那它就该回到同一个机位。
  */
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim().startsWith('适应视图'));
    if (btn) btn.click();
    return true;
  })()`);
  let refitPose = backPose;
  for (let i = 0; i < 40; i += 1) {
    refitPose = await readPose();
    if (refitPose === beforePose) break;
    await sleep(250);
  }
  /* 诊断：按钮到底有没有被点到（多按钮同名 / disabled 都会让"没生效"看起来一样） */
  const fitProbe = await evaluate(`(() => {
    const all = [...document.querySelectorAll('button')].filter((el) => (el.textContent || '').trim().startsWith('适应视图'));
    const btn = all[0] ?? null;
    if (!btn) return { count: 0 };
    let clicks = 0;
    btn.addEventListener('click', () => { clicks += 1; });
    btn.click();
    return { count: all.length, disabled: btn.disabled, clicks };
  })()`);
  check(
    "「适应视图」把镜头放回刚进页面时的取景位（与回放互不干扰）",
    refitPose === beforePose,
    `期望「${beforePose}」　实际「${refitPose}」；按钮 ${fitProbe?.count ?? 0} 个，disabled=${fitProbe?.disabled}，DOM 点击次数=${fitProbe?.clicks}`,
  );

  const frameId = String(recorded?.id ?? "");

  /* ---------- 雷达回波频谱：时域 + 频域两块，量纲是真的，且不写深度 ----------
     用户口径 2026-09-18：「数字孪生的雷达回波频谱真实些」。
     判据（都能证伪）：
       · 面板上同一批次有**两条**曲线：一条时域回波、一条它的频谱；
       · 时域那条是**双极性**（图里有零轴虚线），频谱那条没有零轴；
       · 横轴刻度出现真实单位（ns / MHz），图下那行参数小字写着天线与采样；
       · 全平台口径：这里**不许**出现深度/mm 之类的距离读数。
  */
  /*
    波形面板在「热点详情」里（页面侧栏只放摘要）。先把它打开 ——
    顺带也就验了"从页面点得开详情"这条路。
  */
  const detailOpened = await evaluate(`(() => {
    /*
      ⚠ 按文案找按钮要按**确切的那一个**：页面上不止一处带"详情"字样的东西，
      按 /详情/ 取第一个会点到别的控件（实测点了没反应、弹窗不出现）。
      侧栏那个按钮的文案是「查看完整证据」，按它找最稳。
    */
    const all = [...document.querySelectorAll('button')].filter((el) => (el.textContent || '').trim() === '查看完整证据');
    const btn = all[0] ?? null;
    if (!btn) return { found: false };
    const wasDisabled = btn.disabled;
    btn.click();
    return { found: true, wasDisabled, count: all.length };
  })()`);
  for (let i = 0; i < 40; i += 1) {
    if (await evaluate(`Boolean(document.querySelector('.twin-wave'))`)) break;
    await sleep(250);
  }
  /* 诊断：详情没开出来时，要能一眼看出是"按钮禁用了"还是"弹窗里没有波形" */
  const detailDiag = await evaluate(`(() => ({
    waves: document.querySelectorAll('.twin-wave').length,
    charts: document.querySelectorAll('.wavechart').length,
    dialog: Boolean(document.querySelector('[role="dialog"]')),
    bodyTail: (document.body.textContent || '').replace(/\\s+/g, ' ').slice(-160),
  }))()`);
  const wavePanel = await evaluate(`(() => {
    const blocks = [...document.querySelectorAll('.twin-wave')];
    return blocks.map((block) => {
      const svg = block.querySelector('svg');
      const d = svg?.querySelector('path[stroke]')?.getAttribute('d') || '';
      const ys = d
        .split(/[ML]/)
        .slice(1)
        .map((pair) => Number(pair.trim().split(/\\s+/)[1]))
        .filter((n) => Number.isFinite(n));
      return {
        cap: (block.querySelector('.twin-wave__cap')?.textContent || '').trim(),
        ticks: [...block.querySelectorAll('svg text')].map((el) => (el.textContent || '').trim()),
        zeroAxis: Boolean(svg?.querySelector('line[stroke-dasharray="2 3"]')),
        param: (block.querySelector('.wavechart__param')?.textContent || '').trim(),
        /* 路径的 y 范围：落在画布外说明曲线被画到图外面去了（频谱按 0–1 画就是这个症状） */
        minY: ys.length ? Math.min(...ys) : null,
        maxY: ys.length ? Math.max(...ys) : null,
        height: Number((svg?.getAttribute('viewBox') || '').split(/\\s+/)[3] || 0),
      };
    });
  })()`);
  const echoBlock = (wavePanel ?? []).find((block) => block.cap.includes("回波（时域"));
  const spectrumBlock = (wavePanel ?? []).find((block) => block.cap.includes("频谱（频域"));
  check(
    "波形面板同时给出时域回波与它的频谱（两块）",
    detailOpened?.found === true && Boolean(echoBlock) && Boolean(spectrumBlock),
    `详情按钮 命中=${detailOpened?.found} 禁用=${detailOpened?.wasDisabled} 弹窗=${detailDiag?.dialog} 波形块=${detailDiag?.waves} 图表=${detailDiag?.charts}；` +
      ((wavePanel ?? []).map((block) => block.cap.slice(0, 14)).join(" / ") || `页尾=「${detailDiag?.bodyTail}」`),
  );
  check(
    "时域回波画的是双极性（有零轴、正负都在画布内），频谱画的是 dB（0 在上、负值在下）",
    Boolean(echoBlock?.zeroAxis) &&
      echoBlock?.minY !== null &&
      echoBlock.minY >= -1 &&
      echoBlock.maxY <= echoBlock.height + 1 &&
      spectrumBlock?.maxY !== null &&
      spectrumBlock.maxY <= spectrumBlock.height + 1 &&
      spectrumBlock.minY >= -1,
    `回波 零轴=${echoBlock?.zeroAxis} y∈[${echoBlock?.minY?.toFixed(1)}, ${echoBlock?.maxY?.toFixed(1)}]/${echoBlock?.height}；` +
      `频谱 零轴=${spectrumBlock?.zeroAxis} y∈[${spectrumBlock?.minY?.toFixed(1)}, ${spectrumBlock?.maxY?.toFixed(1)}]/${spectrumBlock?.height}`,
  );
  check(
    "横轴刻度是真实单位（回波 ns、频谱 MHz）",
    (echoBlock?.ticks ?? []).some((text) => text.includes("ns")) &&
      (spectrumBlock?.ticks ?? []).some((text) => text.includes("MHz")),
    `回波刻度 ${(echoBlock?.ticks ?? []).slice(-3).join(" ")}　频谱刻度 ${(spectrumBlock?.ticks ?? []).slice(-3).join(" ")}`,
  );
  check(
    "图下那行参数小字写了天线/采样/时窗，并声明未标定距离轴",
    /中心频率 \d+ MHz/.test(echoBlock?.param ?? "") &&
      /GS\/s/.test(echoBlock?.param ?? "") &&
      /不写作深度/.test(echoBlock?.param ?? ""),
    `参数行=「${echoBlock?.param ?? "（没有）"}」`,
  );
  const panelText = (wavePanel ?? []).map((block) => `${block.cap} ${block.ticks.join(" ")} ${block.param}`).join(" ");
  check(
    "波形面板里不出现任何深度/mm 读数（平台口径：不预画深度）",
    !/深度\s*[:：]?\s*\d/.test(panelText) && !/\d+\s*(mm|cm|厘米|毫米)/.test(panelText),
    panelText.length > 200 ? `${panelText.slice(0, 120)}…` : panelText,
  );

  /* ---------- 波形改造的连带面：另外两个用到同一张图的页面也要画得出来 ----------
     时域回波**有正有负**：如果哪个页面还按老的 0–1 口径画，负半周会被画到坐标轴下面
     （路径的 y 超出画布），页面上看着就是"波形贴着底边"。这里按路径坐标判它没越界。
  */
  const readChart = `(() => {
    const all = [...document.querySelectorAll('.wavechart svg')];
    const svg = all[0];
    if (!svg) return null;
    const d = svg.querySelector('path[stroke]')?.getAttribute('d') || '';
    const ys = d
      .split(/[ML]/)
      .slice(1)
      .map((pair) => Number(pair.trim().split(/\\s+/)[1]))
      .filter((n) => Number.isFinite(n));
    return {
      charts: all.length,
      ticks: [...svg.querySelectorAll('text')].map((el) => (el.textContent || '').trim()),
      minY: ys.length ? Math.min(...ys) : null,
      maxY: ys.length ? Math.max(...ys) : null,
      height: Number((svg.getAttribute('viewBox') || '').split(/\\s+/)[3] || 0),
      head: d.slice(0, 60),
    };
  })()`;

  /* 采集页：直接进得去（波形回放，取向=回波） */
  await evaluate(`location.hash = "#/hardware?tab=capture"`);
  let captureChart = null;
  for (let i = 0; i < 60; i += 1) {
    captureChart = await evaluate(readChart);
    if (captureChart) break;
    await sleep(300);
  }
  check(
    "采集页（波形回放，取向=回波）波形画得出来且没越界",
    Boolean(captureChart) &&
      captureChart.minY !== null &&
      captureChart.minY >= -1 &&
      captureChart.maxY <= captureChart.height + 1 &&
      captureChart.ticks.some((text) => /ns|MHz/.test(text)),
    captureChart
      ? `刻度 ${captureChart.ticks.slice(-3).join(" ")}；y∈[${captureChart.minY?.toFixed(1)}, ${captureChart.maxY?.toFixed(1)}]，画布高 ${captureChart.height}`
      : "没有找到波形图",
  );

  /*
    投屏页（`/present`）显示什么由**服务端的投屏焦点**决定，不是 URL ——
    所以要像讲解人那样先投放一次「采集作业 / Z04 / 复扫批次」，再去看那一页。
    （这条也顺带验了投屏通道：写焦点 → 展示窗口跟着变。）
  */
  const projectionSet = await (async () => {
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: "shi", password: "123456" }),
    });
    const { token } = await login.json();
    const response = await fetch(`${BASE}/api/projection`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "demo-01",
        hold: true,
        viewType: "capture",
        focusIds: ["order:SH-2026-0901", "component:Z04", "batch:scan-Z04-002"],
      }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  })();
  await evaluate(`location.hash = "#/present"`);
  let presentChart = null;
  for (let i = 0; i < 80; i += 1) {
    presentChart = await evaluate(readChart);
    if (presentChart) break;
    await sleep(300);
  }
  check(
    "投屏页（讲解用，取向=频谱）按服务端焦点渲染出波形且没越界",
    projectionSet.status === 200 &&
      Boolean(presentChart) &&
      presentChart.minY !== null &&
      presentChart.minY >= -1 &&
      presentChart.maxY <= presentChart.height + 1 &&
      presentChart.ticks.some((text) => /MHz/.test(text)),
    `投屏焦点接口 ${projectionSet.status}` +
      (presentChart
        ? `；图 ${presentChart.charts} 张；刻度 ${presentChart.ticks.slice(-3).join(" ")}；` +
          `y∈[${presentChart.minY?.toFixed(1)}, ${presentChart.maxY?.toFixed(1)}]，画布高 ${presentChart.height}；路径头=「${presentChart.head}」`
        : "；没有找到波形图"),
  );

  /* ---- ④b 面板能力：改名 / 更新机位 / 位置读数 / 两段式删除 / 巡场 ---- */
  /*
    上面几节为了验波形，把浏览器带去了采集页与投屏页 —— 先回到孪生页，
    等列表真的渲染出来再读；否则读到的是空列表，四条结论全都会假红。
  */
  await evaluate(`location.hash = "#/twin?order=${ORDER_ID}"`);
  for (let i = 0; i < 100; i += 1) {
    if (await evaluate(`Boolean(document.querySelector('.keyframe-list li'))`)) break;
    await sleep(300);
  }
  const renamableId = String(recorded?.id ?? "");
  const kfPanel = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.keyframe-list li')].map((li) => ({
      id: li.querySelector('.keyframe-list__id')?.textContent.trim() ?? '',
      poses: [...li.querySelectorAll('.keyframe-list__pose')].map((el) => el.textContent.trim()),
      ops: [...li.querySelectorAll('.keyframe-list__ops button')].map((b) => b.textContent.trim()),
    }));
    return {
      rows,
      tourButton: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '按顺序巡场'),
      hasRename: Boolean(document.querySelector('.keyframe-list__ops')),
    };
  })()`);

  check(
    "每一行都能「改名 / 更新机位 / 删除」，并给出方位与位置两行读数",
    kfPanel.hasRename &&
      kfPanel.rows.every((row) => row.ops.join(",") === "改名,更新机位,删除") &&
      kfPanel.rows.every((row) => row.poses.length === 2 && /^位置/.test(row.poses[1])),
    kfPanel.rows.map((row) => `${row.id}：${row.poses.join(" ／ ")}`).join(" ｜ "),
  );

  /* 改名：帧号不变、名字真的换了、行上标出"改于谁、什么时候" */
  const KF_NEW_LABEL = "E2E 改名后的机位";
  await evaluate(`(() => {
    const li = [...document.querySelectorAll('.keyframe-list li')].find((el) => el.textContent.includes('${renamableId}'));
    const btn = [...(li?.querySelectorAll('.keyframe-list__ops button') ?? [])].find((b) => b.textContent.trim() === '改名');
    btn?.click();
    return Boolean(btn);
  })()`);
  await sleep(400);
  await evaluate(`(() => {
    const input = document.querySelector('.keyframe-list__rename input');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '${KF_NEW_LABEL}');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const save = [...document.querySelectorAll('.keyframe-list__rename button')].find((b) => b.textContent.trim() === '保存');
    save?.click();
    return Boolean(save);
  })()`);
  await sleep(1300);
  const renamed = await evaluate(`(() => {
    const li = [...document.querySelectorAll('.keyframe-list li')].find((el) => el.textContent.includes('${renamableId}'));
    return {
      text: li?.querySelector('.keyframe-list__meta')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      id: li?.querySelector('.keyframe-list__id')?.textContent.trim() ?? '',
    };
  })()`);
  check(
    "改名生效：名字换了、帧号没动，行上标出「改于谁、什么时候」",
    renamed.id.startsWith(renamableId) && renamed.text.includes(KF_NEW_LABEL) && /改于 \d{2}:\d{2}/.test(renamed.text),
    renamed.text,
  );

  /*
    巡场至少要两个机位（一个机位不叫"按顺序"）——按钮只在两帧以上才出现。
    上一轮只有一帧，控制条根本没渲染，两条判定冤死在这里；不够就当场再打一帧，
    这一帧算本轮工装自己造的，⑥ 里跟 frameId 一起清掉（跑完不留垃圾）。
  */
  let tourFrameId = "";
  if (kfPanel.rows.length < 2) {
    /*
      这一节是刚从采集页/投屏页跳回来的，模型要重新加载 —— 「打关键帧」在
      `stageReady` 之前是置灰的，点了也白点（上一轮就是这样，一帧都没打上）。
      所以先等按钮真的可点，再点，并且确认这一下确实发出去了。
    */
    let compose = null;
    for (let i = 0; i < 100; i += 1) {
      compose = await evaluate(`(() => {
        const btn = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim().startsWith('打关键帧'));
        return btn ? { disabled: btn.disabled, title: btn.title } : null;
      })()`);
      if (compose && !compose.disabled) break;
      await sleep(300);
    }
    const beforeTour = await readRows();
    const clicked = await evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim().startsWith('打关键帧'));
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    })()`);
    for (let i = 0; i < 60; i += 1) {
      const now = await readRows();
      const fresh = now.find((row) => !beforeTour.some((old) => old.id === row.id));
      if (fresh) {
        tourFrameId = fresh.id;
        break;
      }
      await sleep(400);
    }
    if (!tourFrameId) {
      throw new Error(
        `巡场要两个机位，第二帧没打上：按钮${compose?.disabled ? "还置灰着" : "已可点"}` +
          `（disabled=${compose?.disabled}，title=${compose?.title ?? "（没找到按钮）"}，点击发出=${clicked}）`,
      );
    }
  }

  /* 巡场：控制条 + 当前帧高亮（点完要等控制条渲染出来，别抢在渲染前读） */
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '按顺序巡场');
    btn?.click();
    return Boolean(btn);
  })()`);
  let tourStart = { bar: "", ops: [], active: "" };
  for (let i = 0; i < 15; i += 1) {
    tourStart = await evaluate(`(() => ({
      bar: document.querySelector('.keyframe-tour')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      ops: [...document.querySelectorAll('.keyframe-tour__ops button')].map((b) => b.textContent.trim()),
      active: document.querySelector('.keyframe-list li.is-active .keyframe-list__id')?.textContent.trim() ?? '',
    }))()`);
    if (tourStart.bar && tourStart.active) break;
    await sleep(120);
  }
  check(
    "巡场：控制条给出「第 n/N 帧」与上一帧/暂停/下一帧/结束巡场，当前帧在列表里高亮",
    /巡场 第 1[\/]/.test(tourStart.bar) && tourStart.ops.join(",") === "上一帧,暂停,下一帧,结束巡场" && tourStart.active.includes("1."),
    `${tourStart.bar} ｜ ${tourStart.ops.join(" / ")} ｜ 高亮=${tourStart.active}`,
  );

  /* 手动点「下一帧」：走到第 2 帧并转为暂停（人在控节奏） */
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.keyframe-tour__ops button')].find((b) => b.textContent.trim() === '下一帧');
    btn?.click();
    return Boolean(btn);
  })()`);
  await sleep(1000);
  const tourNext = await evaluate(`(() => ({
    bar: document.querySelector('.keyframe-tour')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    paused: /已暂停/.test(document.querySelector('.keyframe-tour')?.textContent ?? ''),
  }))()`);
  check("「下一帧」走到第 2 帧并转为暂停（人在控节奏）", /巡场 第 2[\/]/.test(tourNext.bar) && tourNext.paused, tourNext.bar);

  /* 用户自己动镜头（滚轮）→ 高亮清掉（原来会一直挂着骗人） */
  await evaluate(`(() => {
    const canvas = document.querySelector('canvas');
    const r = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    return true;
  })()`);
  await sleep(800);
  const afterUserMove = await evaluate(`(() => ({
    active: document.querySelectorAll('.keyframe-list li.is-active').length,
    back: [...document.querySelectorAll('.keyframe-list__id')].filter((el) => el.textContent.includes('已回到该机位')).length,
  }))()`);
  check(
    "自己动一下镜头之后，「已回到该机位」的高亮不再挂着（原来会一直骗人）",
    afterUserMove.active === 0 && afterUserMove.back === 0,
    `高亮行 ${afterUserMove.active} · 带「已回到该机位」的行 ${afterUserMove.back}`,
  );

  /* 结束巡场 */
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.keyframe-tour__ops button')].find((b) => b.textContent.trim() === '结束巡场');
    btn?.click();
    return Boolean(btn);
  })()`);
  await sleep(500);
  check("「结束巡场」把控制条收掉", await evaluate(`!document.querySelector('.keyframe-tour')`));

  /* 两段式删除：第一次点只是"举起来"，再点才真删（演示中防误删） */
  await evaluate(`(() => {
    const li = [...document.querySelectorAll('.keyframe-list li')].find((el) => el.textContent.includes('${renamableId}'));
    const btn = [...(li?.querySelectorAll('.keyframe-list__ops button') ?? [])].find((b) => b.textContent.trim() === '删除');
    btn?.click();
    return Boolean(btn);
  })()`);
  await sleep(400);
  const armed = await evaluate(`(() => {
    const li = [...document.querySelectorAll('.keyframe-list li')].find((el) => el.textContent.includes('${renamableId}'));
    return {
      exists: Boolean(li),
      button: [...(li?.querySelectorAll('.keyframe-list__ops button') ?? [])].map((b) => b.textContent.trim()).join(","),
    };
  })()`);
  check(
    "删除是两段式：第一下只是「确认删除」，帧还在（演示中防误删）",
    armed.exists && /确认删除/.test(armed.button),
    `按钮=${armed.button}`,
  );

/* ---------- ⑤ 服务端共享：换账号（饶）也看得到这一帧 ---------- */
  const asShi = await serverKeyframes("shi");
  check(
    "帧存在服务端（不是本机 localStorage）",
    asShi.frames.some((item) => item.id === frameId),
    `场景 ${asShi.sceneId ?? "—"} 上有 ${asShi.frames.length} 帧：${asShi.frames.map((item) => item.id).join(" / ")}`,
  );
  const asRao = await serverKeyframes("rao");
  check(
    "另一个账号（饶）在服务端也看得到同一帧",
    asRao.frames.some((item) => item.id === frameId),
    `饶看到 ${asRao.frames.length} 帧`,
  );

  /* 换浏览器身份（清 token → 用饶登录）再看页面：内网"别人那台"就是这个效果 */
  await evaluate(`(() => {
    for (const key of Object.keys(localStorage)) {
      if (/token|auth|mumai/i.test(key)) localStorage.removeItem(key);
    }
    return true;
  })()`);
  await evaluate(`location.reload()`);
  await sleep(1500);
  await login("rao");
  /*
    登录后会回到默认首页，得再进一次孪生页 —— 这一步正是同事那边的真实动作：
    用自己的账号登录、打开同一个工单的孪生页。
  */
  for (let i = 0; i < 60; i += 1) {
    const hash = String(await evaluate(`location.hash`));
    if (!hash.includes("login")) break;
    await sleep(500);
  }
  await evaluate(`location.hash = '#/twin?order=${ORDER_ID}'`);
  let raoRows = [];
  for (let i = 0; i < 160; i += 1) {
    raoRows = await readRows();
    if (raoRows.some((row) => row.id === frameId)) break;
    await sleep(500);
  }
  check(
    "用饶的账号重新打开这一页，列表里还是有这一帧（「别人也能用」）",
    raoRows.some((row) => row.id === frameId),
    `饶页面上看到：${raoRows.map((row) => row.id).join(" / ") || "（空）"}`,
  );

  /* ---------- ⑥ 删帧：两边都没了（跑完不留垃圾） ---------- */
  /*
    删除是**两段式**（第一下把按钮变成「确认删除」，防演示中误删）——
    工装要按两下：第一下之后帧还在，第二下才真删。第一下"只是举起来"这一条
    在 ④b 里已经单独验过，这里直接连点两下。
  */
  const clickDelete = (id) =>
    evaluate(`(() => {
      const rows = [...document.querySelectorAll('.keyframe-list li')];
      const target = rows.find((li) => (li.querySelector('.keyframe-list__id')?.textContent || '').includes(${JSON.stringify(id)}));
      const btn = [...(target?.querySelectorAll('button') ?? [])].find((el) => ['删除', '确认删除'].includes((el.textContent || '').trim()));
      if (btn) btn.click();
      return btn ? (btn.textContent || '').trim() : null;
    })()`);
  const firstClick = await clickDelete(frameId);
  await sleep(300);
  const armedStillThere = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.keyframe-list li')];
    return rows.some((li) => (li.querySelector('.keyframe-list__id')?.textContent || '').includes(${JSON.stringify(frameId)}));
  })()`);
  check(
    "第一下只是「确认删除」：帧还在（两段式删除防误删）",
    firstClick === "删除" && armedStillThere === true,
    `按钮=${firstClick} · 帧还在=${armedStillThere}`,
  );
  const secondClick = await clickDelete(frameId);
  check("第二下才真的删（按钮文字在这两下之间变成了「确认删除」）", secondClick === "确认删除", `按钮=${secondClick}`);
  let afterDelete = raoRows;
  for (let i = 0; i < 60; i += 1) {
    afterDelete = await readRows();
    if (!afterDelete.some((row) => row.id === frameId)) break;
    await sleep(400);
  }
  check("删除之后页面上没有这一帧了", !afterDelete.some((row) => row.id === frameId), `剩 ${afterDelete.length} 帧`);

  /* 巡场那一帧是本轮为了凑两个机位补打的，一样要清掉 */
  if (tourFrameId) {
    await clickDelete(tourFrameId);
    await sleep(300);
    await clickDelete(tourFrameId);
    for (let i = 0; i < 60; i += 1) {
      const left = await readRows();
      if (!left.some((row) => row.id === tourFrameId)) break;
      await sleep(400);
    }
  }
  const leftoverIds = [frameId, tourFrameId].filter(Boolean);
  const finalRows = await readRows();
  check(
    "跑完不留垃圾：这一轮打的两帧都清掉了",
    !finalRows.some((row) => leftoverIds.includes(row.id)),
    `剩 ${finalRows.length} 帧${finalRows.length ? `：${finalRows.map((row) => row.id).join(" / ")}` : ""}`,
  );
  const afterServerDelete = await serverKeyframes("shi");
  const serverLeftover = afterServerDelete.frames.filter((item) => leftoverIds.includes(item.id));
  check(
    "服务端实体里也清掉了（keyframes 与 bookmarkIds 两份都不留）",
    serverLeftover.length === 0 && !leftoverIds.some((id) => afterServerDelete.bookmarks.includes(id)),
    `剩 ${afterServerDelete.frames.length} 帧；书签 ${afterServerDelete.bookmarks.join(" / ") || "（空）"}`,
  );

  console.log(failed ? `\n有 ${failed} 条没过` : "\n全部通过");
  if (failed) process.exitCode = 1;
} finally {
  try {
    chrome.kill();
  } catch {
    /* 已经退了 */
  }
}
