/**
 * 剧本 25 轮 · 小木音频**实播**全覆盖（真浏览器、真服务端、真录音）
 *
 * ── 补的是哪一段 ────────────────────────────────────────────────
 * `tools/验收-小木音频覆盖.mjs` 只能证明"清单 → 文件 → dist 快照"三层对得上（静态）；
 * `tools/验收-快捷键气泡.mjs` 逐轮验过 ①④⑤⑭⑮⑯㉕ 真的播了录音 —— 中间 18 轮没有运行时证据。
 * 语音包失配是**静默**的（没命中就悄悄换成浏览器合成音，界面看不出异常），
 * 所以"清单里有"不等于"现场会播"。这一份把 25 条快捷键**全部按一遍**：
 *
 *   ① 按的是条目表里的真实键位（`scriptShortcutEntries.ts`，不在这里另抄一份映射）；
 *   ② 按下去这一轮**确实被触发**（气泡里出现该条目的那句话）—— 首屏刚登录时运行时
 *      还没注册，按键会被丢掉，所以这里带重试（第一版就栽在这：第①轮 30 秒没起播，
 *      原因不是没录音，而是按键早于小木挂载）；
 *   ③ 这一轮**真的起播了自己的录音** `/voice/round-NN.mp3`（且 `play()` 没被浏览器拦）；
 *   ④ 音频真的在走（`currentTime` 往前动过，或已经放完）—— 不是"请求了但没解出来"；
 *   ⑤ 全程 `speechSynthesis.speak` **一次都没被调用**（没有一轮回退合成音）。
 *
 * ⚠ 按键用**合成事件**：这里验的是页面自己的派发链路（快捷键 → 剧本 → 播报）。
 *   浏览器加速键那一层由 `tools/验收-浏览器不吃键位.mjs` 用 CDP 真实输入单独验。
 * ⚠ 每轮不等播完就按下一轮（上一轮被打断）—— 要的是"每轮都请求并起播了自己的录音"；
 *   "完整播完 + 真实起止时刻"的证据在 `验收-快捷键气泡.mjs` 的 ④/⑤ 两节。
 * ⚠ `--autoplay-policy=no-user-gesture-required` 不能省：无头环境没有真实手势，
 *   Chrome 会拦掉 `play()`，那样每一轮都会"看起来没播录音"（实测踩过）。
 *
 * 前置：8000 在跑（或 vite dev 5173）。用法：
 *   node tools/验收-小木25轮音频.mjs [--url http://127.0.0.1:8000/]
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

import { SCRIPT_SHORTCUT_ENTRIES } from "../src/pages/MumaiDashboard/agent/scriptShortcutEntries.ts";

const args = process.argv.slice(2);
const urlIndex = args.indexOf("--url");
const BASE = (urlIndex >= 0 ? args[urlIndex + 1] : "http://127.0.0.1:8000/").replace(/\/$/, "");
const PORT = 9521;
const PROFILE = `${process.env.TEMP}\\mumai-voice-cover-profile`;
const SHOT_DIR = process.env.MUMAI_SHOT_DIR ?? "D:\\平台\\验收截图";

/** 轮次表直接来自快捷键条目表：键位、台词、顺序都是同一处事实源 */
const ROUNDS = SCRIPT_SHORTCUT_ENTRIES.map((entry, index) => {
  const round = index + 1;
  const [prefix, digit] = String(entry.key).split(":");
  return {
    round,
    prefix,
    digit,
    file: `round-${String(round).padStart(2, "0")}.mp3`,
    /* 气泡里应当出现的那句话（取前 10 字做包含判断，避开逐字动画的中间态） */
    expect: entry.text.slice(0, 10),
    label: entry.label,
  };
});

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
    "--window-size=1600,1000",
    "--autoplay-policy=no-user-gesture-required",
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
    if (r.result?.exceptionDetails) throw new Error(`页面内抛错：${r.result.exceptionDetails.text ?? ""}`);
    return r.result?.result?.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");

  /* ---------- 登录（shi）---------- */
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
  check("登录成功并进入平台页面（shi）", inApp, `hash=${await evaluate(`location.hash`)}`);
  if (!inApp) throw new Error("没进平台，后面的判定没有意义");

  /* ---------- 音频探针（必须在按第一个快捷键之前装好）----------
     `play()` 的 Promise 结果也要记：被浏览器拦下（NotAllowedError）与"文件放不出来"
     是两件事，不分开记就会把前者误判成"录音缺失"。 */
  await evaluate(`(() => {
    window.__voice = { played: [], synth: 0, last: null };
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      const rec = { src: '', ok: null };
      try {
        rec.src = this.currentSrc || this.src || '';
        window.__voice.played.push(rec);
        window.__voice.last = this;
      } catch (e) {}
      const p = origPlay.apply(this, arguments);
      if (p && typeof p.then === 'function') p.then(() => { rec.ok = true; }, () => { rec.ok = false; });
      return p;
    };
    const synth = window.speechSynthesis;
    if (synth && synth.speak) {
      const origSpeak = synth.speak.bind(synth);
      synth.speak = function () { window.__voice.synth += 1; return origSpeak.apply(null, arguments); };
    }
    return true;
  })()`);

  const playedList = async () => ((await evaluate(`window.__voice.played`)) ?? []).map((r) => ({ src: String(r.src), ok: r.ok }));
  const panelText = () => evaluate(`(document.querySelector('.xd__panel')?.textContent || '')`);
  const lastAudio = () =>
    evaluate(`(() => {
      const el = window.__voice.last;
      if (!el) return null;
      return { src: el.currentSrc || el.src || '', duration: el.duration, currentTime: el.currentTime, ended: el.ended, paused: el.paused };
    })()`);

  /** 按一次单条快捷键（合成事件：验的是页面自己的派发链路） */
  const pressRound = async (prefix, digit) => {
    for (const key of [prefix, digit]) {
      await evaluate(`(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: ${JSON.stringify(key)}, code: 'Key' + ${JSON.stringify(key.toUpperCase())},
          ctrlKey: true, bubbles: true, cancelable: true,
        }));
        return true;
      })()`);
      await sleep(60);
    }
  };

  console.log(`\n逐轮实播核对（${ROUNDS.length} 轮，键位取自 scriptShortcutEntries.ts）\n`);
  const report = [];
  let synthTotal = 0;

  for (const item of ROUNDS) {
    let attempt = 0;
    let started = false;
    let progress = null;
    let list = [];
    let seenQuestion = false;
    let synthThisRound = 0;

    /* 首屏刚登录时小木运行时可能还没注册，按键会被丢掉 —— 没触发就重按（最多 3 次） */
    while (attempt < 3 && !started && !seenQuestion) {
      attempt += 1;
      await evaluate(`(() => { window.__voice.played = []; window.__voice.last = null; window.__voice.synth = 0; return true; })()`);
      await pressRound(item.prefix, item.digit);

      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        list = await playedList();
        if (list.some((r) => r.src.includes(`/voice/${item.file}`))) {
          started = true;
          break;
        }
        if (!seenQuestion) {
          const text = await panelText();
          if (text.includes(item.expect)) seenQuestion = true;
        }
        await sleep(200);
      }
      if (started) break;
      synthThisRound = Number(await evaluate(`window.__voice.synth`)) || 0;
      await sleep(600);
    }

    if (started) {
      /* 起播之后看它是不是真的在走（currentTime 往前动了，或者已经放完） */
      for (let i = 0; i < 25; i += 1) {
        progress = await lastAudio();
        if (progress && (progress.ended || progress.currentTime > 0.2)) break;
        await sleep(200);
      }
      if (!synthThisRound) synthThisRound = Number(await evaluate(`window.__voice.synth`)) || 0;
    }
    synthTotal += synthThisRound;

    const played = list.find((r) => r.src.includes(`/voice/${item.file}`));
    const okStart = started && played?.ok !== false;
    const okProgress = Boolean(progress && (progress.ended || progress.currentTime > 0.2) && Number(progress.duration) > 0);
    report.push({ ...item, attempt, okStart, okProgress, seenQuestion, duration: progress?.duration ?? null, fallback: synthThisRound });
    check(
      `第 ${String(item.round).padStart(2, "0")} 轮 · ${item.file} 起播且真的在放`,
      okStart && okProgress,
      started
        ? `时长 ${Number(progress?.duration ?? 0).toFixed(1)}s　已走 ${Number(progress?.currentTime ?? 0).toFixed(1)}s${progress?.ended ? "（已放完）" : ""}${attempt > 1 ? `　第 ${attempt} 次按键才触发` : ""}`
        : `45 秒内没起播；这一轮被触发=${seenQuestion}；实际播过：${list.map((r) => r.src.split("/").pop()).join("、") || "无"}`,
    );
  }

  /* ---------- 汇总 ---------- */
  const startedAll = report.filter((r) => r.okStart).length;
  const playedAll = report.filter((r) => r.okStart && r.okProgress).length;
  check(`25 轮全部起播自己的录音（${startedAll}/25）`, startedAll === ROUNDS.length, `起播 ${startedAll} 轮`);
  check(`25 轮的音频都真的在走（${playedAll}/25）`, playedAll === ROUNDS.length, `在走 ${playedAll} 轮`);
  check(
    "全程没有一轮回退浏览器合成音",
    synthTotal === 0,
    synthTotal === 0 ? "speechSynthesis.speak 调用 0 次" : `被调用 ${synthTotal} 次：第 ${report.filter((r) => r.fallback > 0).map((r) => r.round).join("、")} 轮`,
  );

  console.log("\n  轮次 → 音频 → 实播：");
  for (const row of report) {
    console.log(
      `    ${String(row.round).padStart(2, "0")}  ${row.file}  ${row.okStart ? "起播✓" : "未起播✗"}  ${
        row.okProgress ? "在走✓" : "没走✗"
      }  ${row.duration ? `${Number(row.duration).toFixed(1)}s` : "—"}${row.attempt > 1 ? `　（重按 ${row.attempt} 次）` : ""}`,
    );
  }

  try {
    mkdirSync(SHOT_DIR, { recursive: true });
    const r = await send("Page.captureScreenshot", { format: "png" });
    const data = r?.result?.data;
    if (data) {
      const file = `${SHOT_DIR}\\小木25轮音频-最后一轮.png`;
      writeFileSync(file, Buffer.from(data, "base64"));
      console.log(`\n  截图：${file}`);
    }
  } catch {
    /* 截图失败不影响判定 */
  }
} finally {
  chrome.kill();
}

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项未通过`}`);
process.exit(failed === 0 ? 0 : 1);
