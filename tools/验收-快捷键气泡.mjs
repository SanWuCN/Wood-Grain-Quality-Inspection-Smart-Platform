/**
 * 剧本快捷键 · 气泡与逐字显示 端到端验收
 *
 * ── 为什么写这个（用户实测报的 bug）────────────────────────────────
 * 原话：「小木现在用快捷键唤醒有个问题，点击的时候小木应该有正在录入的样子，
 *        应该弹出气泡显示逐渐接收消息，我这边实测下来是小木没反应，
 *        过一会儿突然就接收到一整句话。」
 *
 * 根因（已定位）：`useScriptShortcut` 只把逐字文本写进 `agent.partial`，**从不置 `open`**；
 * 而气泡面板的门控是 `if (!agent.open && !expanded) return;`（`XiaomuDock.tsx:359`）。
 * 于是那串 partial 一直在 store 里累积，屏幕上**没有容器显示它**，
 * 直到 `ask()` 收尾才看到整句 —— 与用户描述完全一致。
 *
 * ── 判据（都能证伪，不是"看着像"）──────────────────────────────────
 *   ① 按下 Ctrl+B+1 后 **400ms 内**气泡面板出现在 DOM 里（`visible` 变真）；
 *   ② 识别期间用户气泡里的文字**至少出现 3 个不同长度**（逐字累积；
 *      若只在最后一次性出现，这条必红 —— 那正是本次修的 bug）；
 *   ③ 采样到的最大长度**小于**该句总长度（证明是"逐渐"，不是"一次给完"）；
 *   ④ 随后小木的回复出现（`ask()` 链路真的跑通了，不是只画了个空泡）。
 *
 * ⚠ 判断"逐字"**不能用"帧间有变化"**：那条件在动画/浮动下恒真（见 voice-module/AGENTS.md
 *   记的假绿教训）。这里用**文本长度序列**，它是单调递增的离散量，能证伪。
 *
 * 前置：8000（或 5173）在跑。
 * 用法：node 'D:\平台\voice-module\tools\验收-快捷键气泡.mjs' [--url http://127.0.0.1:8000/]
 */
import { existsSync, rmSync } from "node:fs";

const args = process.argv.slice(2);
const urlIndex = args.indexOf("--url");
const PAGE = urlIndex >= 0 ? args[urlIndex + 1] : "http://127.0.0.1:8000/";
const PORT = 9502;
const PROFILE = `${process.env.TEMP}\\mumai-shortcut-bubble-profile`;

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
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
    "--autoplay-policy=no-user-gesture-required",
    "--mute-audio",
    "--window-size=1440,900",
    PAGE,
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForTarget(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  const want = new URL(PAGE);
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(
        (t) => t.type === "page" && t.webSocketDebuggerUrl && t.url.startsWith(want.origin),
      );
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error("等不到可调试的页面（服务在跑吗？）");
}

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `　（${detail}）` : ""}`);
  if (!ok) failed += 1;
};

/**
 * 截个图存盘（证据图）。
 * 判据是数字，但"长什么样"只有图能说明 —— 用户要的是**看到的**预警窗，
 * 所以每次验收都把当时的画面落一份，方便肉眼复核。
 */
const SHOT_DIR = "D:\\平台\\_归档-临时产物-20260917";
async function shot(send, name) {
  try {
    const r = await send("Page.captureScreenshot", { format: "png" });
    const data = r?.result?.data;
    if (!data) return null;
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(SHOT_DIR, { recursive: true });
    const file = `${SHOT_DIR}\\快捷键验收-${name}.png`;
    writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  } catch {
    return null;
  }
}

try {
  const ws = new WebSocket(await waitForTarget());
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
    const r = await send("Runtime.evaluate", {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description ?? "页面内抛错");
    }
    return r.result?.result?.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");

  /* ---------- 登录（账号来自 start-platform.cmd 的说明）---------- */
  for (let i = 0; i < 60; i += 1) {
    if (await evaluate(`Boolean(document.querySelector('input'))`)) break;
    await sleep(500);
  }
  await evaluate(`(async () => {
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
  for (let i = 0; i < 60; i += 1) {
    const st = await evaluate(
      `({ hash: location.hash, nav: document.querySelectorAll('nav button, nav a, aside button').length })`,
    );
    if (st && !String(st.hash).includes("login") && st.nav > 0) {
      inApp = true;
      break;
    }
    await sleep(500);
  }
  check("登录成功并进入平台页面", inApp, `hash=${await evaluate(`location.hash`)}`);

  /* 采集"气泡是否在"与"用户气泡文字"的取样器，注入页面供轮询调用 */
  await evaluate(`(() => {
    window.__probe = () => {
      const panel = document.querySelector('.xd__panel');
      const bubbles = document.querySelectorAll('.xd__panel .xd__user, .xd__panel [class*="user"]');
      const texts = [...bubbles].map((el) => (el.textContent || '').trim()).filter(Boolean);
      return {
        panelShown: Boolean(panel),
        state: (document.querySelector('.xd__state')?.textContent || '').trim(),
        userTexts: texts,
      };
    };
    /* 音频探针：必须在按快捷键**之前**装好，否则抓不到这一轮的播放 */
    window.__audio = { played: [], synth: 0 };
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      try { window.__audio.played.push(this.currentSrc || this.src || ''); } catch (e) {}
      return origPlay.apply(this, arguments);
    };
    const synth = window.speechSynthesis;
    if (synth && synth.speak) {
      const origSpeak = synth.speak.bind(synth);
      synth.speak = function () {
        window.__audio.synth += 1;
        return origSpeak.apply(null, arguments);
      };
    }
    return true;
  })()`);

  /* ---------- 触发 Ctrl+B+1（第①轮 · 三个月巡检与风险统计）---------- */
  const dispatch = (key) =>
    evaluate(`(() => {
      const opts = { key: ${JSON.stringify(key)}, code: 'Key' + ${JSON.stringify(key.toUpperCase())},
                     ctrlKey: true, bubbles: true, cancelable: true };
      window.dispatchEvent(new KeyboardEvent('keydown', opts));
      return true;
    })()`);

  const T0 = Date.now();
  await dispatch("b");
  await dispatch("1");

  /* ---------- ① 气泡是否很快出现 ---------- */
  let appearMs = -1;
  for (let i = 0; i < 40; i += 1) {
    const p = await evaluate(`window.__probe()`);
    if (p?.panelShown) {
      appearMs = Date.now() - T0;
      break;
    }
    await sleep(50);
  }
  check("按下快捷键后气泡面板出现", appearMs >= 0, appearMs >= 0 ? `${appearMs}ms` : "始终没出现");
  check("气泡在 400ms 内出现（现场「有反应」的手感）", appearMs >= 0 && appearMs <= 400, `${appearMs}ms`);

  /* ---------- ②③ 逐字累积：采样文字长度序列 ---------- */
  const lengths = [];
  const states = new Set();
  for (let i = 0; i < 60; i += 1) {
    const p = await evaluate(`window.__probe()`);
    if (p) {
      states.add(p.state);
      const longest = Math.max(0, ...p.userTexts.map((t) => t.length));
      if (longest > 0) lengths.push(longest);
    }
    await sleep(80);
  }
  const uniq = [...new Set(lengths)].sort((a, b) => a - b);
  const shotStream = await shot(send, "1-逐字识别中的气泡");
  check(
    "识别期间文字逐字累积（≥3 个不同长度）",
    uniq.length >= 3,
    `长度序列 ${uniq.slice(0, 8).join("→")}${uniq.length > 8 ? "…" : ""}`,
  );
  check(
    "最大长度小于整句（证明「逐渐」而不是「一次给完」）",
    uniq.length > 0 && uniq[uniq.length - 1] < 60,
    `最大 ${uniq[uniq.length - 1] ?? 0} 字`,
  );
  console.log(`    识别期间出现过的状态：${[...states].filter(Boolean).join(" / ") || "（无）"}`);

  /* ---------- ④ 小木的回复最终出现 ---------- */
  let replied = false;
  for (let i = 0; i < 80; i += 1) {
    const p = await evaluate(`(() => {
      const t = document.querySelector('.xd__panel');
      return { shown: Boolean(t), text: (t?.textContent || '') };
    })()`);
    if (p?.shown && /RAG知识库|巡检4处地点/.test(p.text)) {
      replied = true;
      break;
    }
    await sleep(250);
  }
  check("随后小木给出该轮回复（ask 链路跑通）", replied);

  /* ---------- ⑤ 那一轮播的到底是**录音**还是浏览器合成音 ----------
     用户 2026-09-17 的交付要求里有"音频能正常使用"。判据直接看运行时：
       · `new Audio(url)` 拿到的 url 必须命中语音包（形如 /voice/round-01.mp3）；
       · 同时 `speechSynthesis.speak` **不该**被调用 —— 被调用就说明回退成合成音了
         （现场表现是"声音还是机器的"，而页面上看不出任何异常）。
     探针在按键之前就装好了（见上面 `window.__audio`），所以这里读到的是这一轮的真实播放。
  */
  /*
    ⚠ 这里必须**轮询**，不能回复文字一出现就断言：实测 `ask()` 是先把回答推进对话
    （文字先上屏），随后才调 `speak()` 起播 —— 立刻取会读到空数组，误判成"没播录音"。
    判据等的是"这一轮确实播了"，不是"此刻已经播了"。
  */
  let audio1 = null;
  let played1 = [];
  for (let i = 0; i < 40; i += 1) {
    audio1 = await evaluate(`window.__audio`);
    played1 = (audio1?.played ?? []).filter(Boolean);
    if (played1.some((u) => String(u).includes("/voice/round-01.mp3"))) break;
    await sleep(250);
  }
  check(
    "第①轮播的是预录录音（/voice/round-01.mp3）",
    played1.some((u) => String(u).includes("/voice/round-01.mp3")),
    played1.length ? played1.map((u) => String(u).split("/").pop()).join(" / ") : "没有任何 Audio.play()",
  );
  check("第①轮没有回退到浏览器合成音", (audio1?.synth ?? 0) === 0, `speechSynthesis.speak 调用 ${audio1?.synth ?? 0} 次`);

  /* ---------- ⑤ 第④轮「同步备份」：快捷键要能把同步备份小窗也带出来 ----------
     这一轮是用户 2026-09-17 文档第 4 条拆出来的独立轮次，它的可见动作有两个：
     工单详情页逐组展开 + 播报收尾弹「同步备份小窗」（executor 派发 `mumai:sync-backup`）。
     快捷键若只"念台词"而不跑剧本动作，这里就会红 —— 所以这条判据能证明整条链路是通的。
  */
  await evaluate(`(() => {
    window.__probeSync = () => Boolean(document.querySelector('.sxb'));
    window.__audio = { played: [], synth: 0 };
    return true;
  })()`);
  /* 先等第①轮的播报彻底收尾，避免两条模拟抢同一个 ask 队列 */
  await sleep(6000);
  await dispatch("b");
  await dispatch("4");
  let syncShown = false;
  for (let i = 0; i < 120; i += 1) {
    if (await evaluate(`window.__probeSync()`)) {
      syncShown = true;
      break;
    }
    await sleep(250);
  }
  check("Ctrl+B+4 之后弹出同步备份小窗（第④轮的可见动作落地）", syncShown);
  await shot(send, "3-第④轮同步备份小窗");

  const audio4 = await evaluate(`window.__audio`);
  const played4 = (audio4?.played ?? []).filter(Boolean);
  check(
    "第④轮播的是预录录音（/voice/round-04.mp3）",
    played4.some((u) => String(u).includes("/voice/round-04.mp3")),
    played4.length ? played4.map((u) => String(u).split("/").pop()).join(" / ") : "没有任何 Audio.play()",
  );
  check("第④轮没有回退到浏览器合成音", (audio4?.synth ?? 0) === 0, `speechSynthesis.speak 调用 ${audio4?.synth ?? 0} 次`);

  /* ---------- ⑥ 第⑬轮「适用性预警」：小木**主动发起**，而且要弹预警窗 ----------
     两件事一起验（都是用户 2026-09-17 的口径）：
       甲「部分主动触发的对话，其也会模拟接受消息，这是不对的，应该在我按按钮后
          小木思考一小会儿后主动说话」—— 所以按键后气泡里**不许**出现"逐字收到"的文字，
          只该看到"思考中"；
       乙「⑬ 这个触发时，会弹出预警窗口，然后带个确认按钮」—— 预警样式 + 确认按钮。

     判据全部可证伪：
       · 按键后 2 秒内 `.xd__user` 里的文字长度**始终为 0**（老实现会逐字涨上去）；
       · 同一窗口里状态出现过「思考」；
       · 出现 `.dsf--alert`（预警样式），不是普通数据面板；
       · 窗里有一个按钮，文案就是确认按钮；
       · 窗里的数据行**没有一行是缺失态**（证明挂的数据键在构建产物里真的取得到值）；
       · 点下去之后按钮禁用 + 说明变成"已更新平台状态，未向设备发送指令"（只改本地状态）。
  */
  await evaluate(`(() => {
    window.__probeAlert = () => {
      const box = document.querySelector('.dsf--alert');
      if (!box) return { shown: false };
      const btn = box.querySelector('.dsf__btn');
      return {
        shown: true,
        title: (box.querySelector('.dsf__title')?.textContent || '').trim(),
        chip: (box.querySelector('.dsf__alert')?.textContent || '').trim(),
        btnText: btn ? (btn.textContent || '').trim() : '',
        btnDisabled: btn ? btn.disabled : null,
        missingRows: box.querySelectorAll('.dsf__row.is-missing').length,
        note: (box.querySelector('.dsf__note')?.textContent || '').trim(),
      };
    };
    return true;
  })()`);
  await sleep(1500);
  /*
    ⚠ 判据要按"**有没有新的**用户文本"来写，不能按"气泡里有没有用户文本"：
    面板是**对话历史**，上一轮（Ctrl+B+4）的「小木，请帮我做同步备份。」还挂在上面，
    按"非空即失败"会把它误判成这一轮收到了消息（第一版就是这么假红的）。
    所以先记下按键前的基线，再看这 2 秒里有没有**新增**。
  */
  const baselineProbe = await evaluate(`window.__probe()`);
  const baselineTexts = new Set(baselineProbe?.userTexts ?? []);
  const alertT0 = Date.now();
  await dispatch("n");
  await dispatch("3");

  /* 甲：按键后 2 秒内不许出现**新的**用户文本，尤其不许出现第⑬轮那句（老实现会逐字涨上去） */
  const newUserTexts = [];
  const seenStates = new Set();
  while (Date.now() - alertT0 < 2000) {
    const p = await evaluate(`window.__probe()`);
    if (p) {
      for (const t of p.userTexts ?? []) {
        if (t && !baselineTexts.has(t)) newUserTexts.push(t);
      }
      if (p.state) seenStates.add(p.state);
    }
    await sleep(80);
  }
  check(
    "主动发起不模拟「收到消息」（按键后没有出现新的用户文本）",
    newUserTexts.length === 0,
    newUserTexts.length ? `新增了「${newUserTexts.slice(0, 3).join(" / ")}…」` : `基线 ${baselineTexts.size} 条，2 秒内无新增`,
  );
  check(
    "第⑬轮那句没有被当成「听到的话」显示出来",
    !newUserTexts.some((t) => t.includes("适用性预警")),
    newUserTexts.some((t) => t.includes("适用性预警")) ? "被当成用户消息逐字显示了" : "没有出现",
  );
  check(
    "按键后进入思考态（小木思考一小会儿再开口）",
    [...seenStates].some((s) => s.includes("思考")),
    `出现过的状态：${[...seenStates].join(" / ") || "（无）"}`,
  );
  /* 这张图就是这次修的那件事：气泡里是"思考中"，**没有**逐字收到的用户文本 */
  await shot(send, "4-主动发起-思考中（没有收到消息）");

  let alertWin = { shown: false };
  for (let i = 0; i < 240; i += 1) {
    alertWin = await evaluate(`window.__probeAlert()`);
    if (alertWin?.shown) break;
    await sleep(250);
  }
  check("Ctrl+N+3 之后弹出预警窗（.dsf--alert）", Boolean(alertWin?.shown), alertWin?.title || "始终没出现");
  await shot(send, "2-第⑬轮预警窗");
  check("预警窗带「预警」角标", alertWin?.chip === "预警", `角标=「${alertWin?.chip ?? ""}」`);
  check("预警窗里有确认按钮", Boolean(alertWin?.btnText), `按钮=「${alertWin?.btnText ?? ""}」`);
  check("预警窗的数据行都取到了值（没有缺失态）", alertWin?.missingRows === 0, `缺失 ${alertWin?.missingRows ?? "?"} 行`);
  check(
    "确认按钮的默认说明说清影响范围",
    String(alertWin?.note ?? "").includes("不向设备发送指令"),
    `说明=「${alertWin?.note ?? ""}」`,
  );

  /* 真的点一下：必须变成"已确认"，且按钮禁用（不可重复确认） */
  await evaluate(`(() => {
    const btn = document.querySelector('.dsf--alert .dsf__btn');
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(400);
  const afterClick = await evaluate(`window.__probeAlert()`);
  check(
    "点确认后说明变为「已更新平台状态，未向设备发送指令」",
    String(afterClick?.note ?? "").includes("已更新平台状态"),
    `说明=「${afterClick?.note ?? ""}」`,
  );
  check("点确认后按钮禁用（不会重复确认）", afterClick?.btnDisabled === true, `disabled=${afterClick?.btnDisabled}`);

  await evaluate(`window.__probe = undefined; window.__probeSync = undefined; window.__probeAlert = undefined`);

  /* ---------- ⑦ 气泡里的「快捷键一览」（别人在内网机器上得看得到这张表）----------
     用户口径 2026-09-17：「小木呢，别人内网登上去也得能用快捷键呼唤出来相应对话」。
     快捷键本身在任何机器上都好使（本脚本就是证明），缺的是"别人怎么知道按哪个键" ——
     所以气泡里必须有一张从剧本生成的表，且内网 http 打开时要如实说明麦克风用不了。
  */
  const isLoopback = /^(127\.0\.0\.1|localhost)$/i.test(new URL(PAGE).hostname);
  const openedSheet = await evaluate(`(() => {
    /* 面板没开就先点形象展开（前面几段结束时应该还开着，这里只做兜底） */
    if (!document.querySelector('.xd__panel')) {
      const avatar = document.querySelector('.xd__avatar');
      if (avatar) avatar.click();
    }
    const btn = [...document.querySelectorAll('.xd__fold-btn')].find((b) =>
      (b.textContent || '').includes('快捷键一览'),
    );
    if (btn && btn.getAttribute('aria-expanded') !== 'true') btn.click();
    return Boolean(btn);
  })()`);
  await sleep(400);
  const sheet = await evaluate(`(() => {
    const list = document.querySelector('.xd__keys');
    const items = list ? [...list.querySelectorAll('li')] : [];
    const note = document.querySelector('.xd__keys-wrap .xd__note');
    return {
      found: Boolean(list),
      count: items.length,
      first: (items[0]?.querySelector('b')?.textContent || '').trim(),
      last: (items[items.length - 1]?.querySelector('b')?.textContent || '').trim(),
      note: note ? (note.textContent || '').replace(/\\s+/g, ' ').trim() : '',
    };
  })()`);
  check("气泡里能找到「快捷键一览」入口", openedSheet);
  check(
    "一览表列出全部 25 条（任何机器都看得到键位）",
    Boolean(sheet?.found) && sheet.count === 25,
    `${sheet?.count ?? 0} 条`,
  );
  check(
    "首尾键位对得上（Ctrl+B+1 … Ctrl+M+5）",
    sheet?.first === "Ctrl+B+1" && sheet?.last === "Ctrl+M+5",
    `${sheet?.first ?? "?"} … ${sheet?.last ?? "?"}`,
  );
  if (isLoopback) {
    check(
      "本机（localhost）不显示麦克风受限提示（能用就不吓人）",
      !String(sheet?.note ?? "").includes("麦克风"),
      sheet?.note ? `却显示了「${sheet.note.slice(0, 30)}…」` : "没有提示",
    );
  } else {
    check(
      "内网 http 打开时如实说明麦克风用不了（而不是让人以为小木坏了）",
      String(sheet?.note ?? "").includes("麦克风"),
      sheet?.note ? `提示「${sheet.note.slice(0, 40)}…」` : "没有任何提示",
    );
  }
  await shot(send, "5-气泡里的快捷键一览");

  /* ---------- ⑧ 第⑤轮天气：台词里的数据必须与屏幕上的天气面板**同一份** ----------
     用户口径 2026-09-17：「第5个对话，天气那个，小木的回答带上较为真实的数据，
     与平台不穿帮，没音频去网站合成」。

     这一条要证三件事，缺一不可：
       · 小木念的那句话里带上了四个真实数字（412 / 37 / 52.6 / 78 / 17.8）；
       · **同屏的「平台环境档案」面板上写的是同一组数字**（这才叫不穿帮）——
         判据是"面板文本里也能找到这些数字"，任一侧改了口径都会红；
       · 播的是刚合成的 web 录音（/voice/round-05.mp3），没有回退合成音。
  */
  await evaluate(`(() => { window.__audio = { played: [], synth: 0 }; return true; })()`);
  await sleep(1500);
  await dispatch("b");
  await dispatch("5");

  /* 先等气泡里的回答出现（文字先上屏），立刻核对数字 */
  let weatherAnswer = "";
  for (let i = 0; i < 120; i += 1) {
    weatherAnswer = await evaluate(`(() => {
      const el = document.querySelector('.xd__panel .xd__answer');
      return el ? (el.textContent || '') : '';
    })()`);
    if (weatherAnswer.includes("天气查询")) break;
    await sleep(250);
  }
  const NUMBERS = ["412", "37", "52.6", "78", "17.8"];
  const missingInSpeech = NUMBERS.filter((n) => !weatherAnswer.includes(n));
  check(
    "第⑤轮台词带上了平台真实天气数据（412/37/52.6/78/17.8）",
    missingInSpeech.length === 0,
    missingInSpeech.length ? `缺 ${missingInSpeech.join(" / ")}：${weatherAnswer.slice(0, 60)}…` : weatherAnswer.slice(0, 70),
  );

  /* 等天气面板出现（它在播报收尾才派发），再比对同屏数字 */
  let panelText = "";
  for (let i = 0; i < 240; i += 1) {
    panelText = await evaluate(`(() => {
      const el = document.querySelector('.dsf');
      return el ? (el.textContent || '') : '';
    })()`);
    const ready = NUMBERS.every((n) => panelText.includes(n));
    if (ready) break;
    await sleep(500);
  }
  const missingOnPanel = NUMBERS.filter((n) => !panelText.includes(n));
  check(
    "同屏「平台环境档案」面板上写的是同一组数字（不穿帮）",
    missingOnPanel.length === 0 && panelText.length > 0,
    missingOnPanel.length ? `面板缺 ${missingOnPanel.join(" / ")}` : `面板文本 ${panelText.length} 字，五个数字都在`,
  );

  /*
    ⚠ 音频这一格必须**轮询**（与第①轮同样的理由）：`speak()` 在这一轮收尾才起播，
    而"天气面板出现"与"play() 被调用"几乎同一瞬间 —— 早一次采样就会读到空数组，
    误判成"没播录音"（实测踩到过：判据红、其实录音正常）。
  */
  let audio5 = null;
  let played5 = [];
  for (let i = 0; i < 60; i += 1) {
    audio5 = await evaluate(`window.__audio`);
    played5 = (audio5?.played ?? []).filter(Boolean);
    if (played5.some((u) => String(u).includes("/voice/round-05.mp3"))) break;
    await sleep(500);
  }
  check(
    "第⑤轮播的是重新合成的录音（/voice/round-05.mp3）",
    played5.some((u) => String(u).includes("/voice/round-05.mp3")),
    played5.length ? played5.map((u) => String(u).split("/").pop()).join(" / ") : "没有任何 Audio.play()",
  );
  check("第⑤轮没有回退到浏览器合成音", (audio5?.synth ?? 0) === 0, `speechSynthesis.speak 调用 ${audio5?.synth ?? 0} 次`);
  await shot(send, "6-第⑤轮天气（台词与面板同一组数字）");
} finally {
  chrome.kill();
}

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项未通过`}`);
process.exit(failed === 0 ? 0 : 1);
