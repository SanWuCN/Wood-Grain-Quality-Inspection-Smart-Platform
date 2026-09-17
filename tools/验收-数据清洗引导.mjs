/**
 * ⑰ 数据清洗 · 「一步一步引导到人工核验」端到端验收（真浏览器、真服务端、真语音）
 *
 * ── 用户口径（2026-09-18）────────────────────────────────────────
 * 「小木，启动数据清洗…这个对话需要小木跳转到固件及模型，数据集，
 *   直接一步一步引导到人工核验」，以及「这个数据集数据清洗可以搞得更详细和真实，
 *   步骤可以稍微复杂些」。
 *
 * 所以这一份工装要证明四件事，每条都能证伪：
 *   ① 按 Ctrl+Y 7（第⑰轮）小木会**跳到**「固件及模型 → 数据集」页，不是只念台词；
 *   ② 页面上的清洗流程**跟着播报逐拍往前走**（选数据集 → 配置 → 预检查 → 执行清洗），
 *      最后停在「执行清洗」，**人工核验一步不替人点**（脚本不许替人做核验）；
 *   ③ 「更详细和真实」= 8 步流水线**逐步给数**：每步输入/保留/待核验 + 命中了哪几条
 *      记录，且与核验弹窗里逐条对得上（不是一张"全部完成"的静态表）；
 *   ④ 这一轮放的是**音频文件**，不是退回浏览器合成音（⑰ voicePack = AI语音5）。
 *
 * 前置：8000 在跑（页面 + API + 语音同一个服务）。用法：
 *   node tools/验收-数据清洗引导.mjs [--url http://127.0.0.1:8000/]
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const urlIndex = args.indexOf("--url");
const BASE = (urlIndex >= 0 ? args[urlIndex + 1] : "http://127.0.0.1:8000/").replace(/\/$/, "");
const PORT = 9507;
const PROFILE = `${process.env.TEMP}\\mumai-clean-flow-profile`;
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
    "--window-size=1600,1000",
    /* 无头环境没有真实用户手势，Chrome 会拦掉 <audio>.play() → 页面看起来像"退回合成音"。
       这一轮要验的正是"放的是录音文件"，所以按既有工装的口径放开自动播放策略。 */
    "--autoplay-policy=no-user-gesture-required",
    /* 静音但**不禁用**播放：这一轮要确认放的是音频文件（muted 不影响 play/ended） */
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
    if (r.result?.exceptionDetails) {
      throw new Error(`页面内抛错：${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`);
    }
    return r.result?.result?.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");

  /** 存一张现场图（流程态 / 核验弹窗各一张，便于人复核版面） */
  const shot = async (name) => {
    try {
      mkdirSync(SHOT_DIR, { recursive: true });
      const r = await send("Page.captureScreenshot", { format: "png" });
      const data = r?.result?.data;
      if (!data) return null;
      const file = `${SHOT_DIR}\\${name}.png`;
      writeFileSync(file, Buffer.from(data, "base64"));
      console.log(`  · 现场截图：${file}`);
      return file;
    } catch {
      return null;
    }
  };

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

  /* ---------- 音频探针（必须在按快捷键之前装好）---------- */
  await evaluate(`(() => {
    window.__audio = { played: [], synth: 0 };
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      try { window.__audio.played.push(this.currentSrc || this.src || ''); } catch (e) {}
      return origPlay.apply(this, arguments);
    };
    const synth = window.speechSynthesis;
    if (synth && synth.speak) {
      const origSpeak = synth.speak.bind(synth);
      synth.speak = function () { window.__audio.synth += 1; return origSpeak.apply(null, arguments); };
    }
    return true;
  })()`);

  /* ---------- 触发 Ctrl+Y 7（第⑰轮 · 数据清洗与人工审核）---------- */
  const dispatch = (key) =>
    evaluate(`(() => {
      const opts = { key: ${JSON.stringify(key)}, code: ${JSON.stringify(key === "y" ? "KeyY" : `Digit${key}`)},
                     ctrlKey: true, bubbles: true, cancelable: true };
      window.dispatchEvent(new KeyboardEvent('keydown', opts));
      return true;
    })()`);

  await dispatch("y");
  await dispatch("7");

  /* ---------- ① 跳到「固件及模型 → 数据集」 ---------- */
  let hash = "";
  for (let i = 0; i < 80; i += 1) {
    hash = String(await evaluate(`location.hash`));
    if (hash.includes("firmware") && hash.includes("dataset")) break;
    await sleep(250);
  }
  check("按 Ctrl+Y 7 后跳到固件及模型 · 数据集页", hash.includes("firmware") && hash.includes("dataset"), hash);

  /* ---------- ② 清洗流程页确实挂在这一页上 ---------- */
  let track = null;
  for (let i = 0; i < 80; i += 1) {
    track = await evaluate(`(() => {
      const ol = document.querySelector('.dc-track');
      if (!ol) return null;
      return { steps: [...ol.querySelectorAll('li b')].map((el) => el.textContent.trim()) };
    })()`);
    if (track) break;
    await sleep(250);
  }
  check("数据集页上出现清洗流程轨道（选数据集 → … → 生成版本）", Boolean(track), track ? track.steps.join(" → ") : "始终没有 .dc-track");
  check(
    "流程轨道共 6 步，与页面声明的阶段一致",
    Boolean(track) && track.steps.length === 6 && track.steps[0] === "选择原始数据集" && track.steps[5] === "生成数据集版本",
    track ? `${track.steps.length} 步` : "—",
  );

  /* ---------- ③ 跟着播报走到「执行清洗」，停住不替人点人工核验 ---------- */
  const probe = () => evaluate(`(() => {
    const panel = document.querySelector('.dc-track')?.closest('.tech-panel');
    const nextLi = [...document.querySelectorAll('.dc-track li')].find((li) => li.classList.contains('is-next'));
    const buttons = [...document.querySelectorAll('.dc-stage button')].map((el) => el.textContent.trim());
    return {
      current: nextLi ? nextLi.querySelector('b')?.textContent.trim() : null,
      done: [...document.querySelectorAll('.dc-track li.is-done b')].map((el) => el.textContent.trim()),
      buttons,
      hasReviewButton: buttons.some((t) => t.startsWith('下一步：人工核验')),
      text: panel ? panel.textContent.replace(/\\s+/g, ' ').trim() : '',
    };
  })()`);

  let state = null;
  let reachedMs = -1;
  const T0 = Date.now();
  for (let i = 0; i < 240; i += 1) {
    state = await probe();
    if (state?.hasReviewButton) {
      reachedMs = Date.now() - T0;
      break;
    }
    await sleep(250);
  }
  check("清洗流程跟着播报一路走到「执行清洗」（每步都真跑规则，不是一进来就全亮）", reachedMs >= 0, reachedMs >= 0 ? `${(reachedMs / 1000).toFixed(1)}s` : `停在「${state?.current ?? "?"}」`);

  /*
    页面停稳（数字动效走完）再取数：KPI 与按钮上的条数都是逐帧动画，
    取早了会读到中间值（实测按钮上读到「人工核验 1 条」，而实际是 4 条）。
  */
  await sleep(1500);
  state = await probe();
  check(
    "停在「执行清洗」这一步，人工核验没有被脚本替人点掉",
    state?.current === "执行清洗" && !state.done.includes("人工核验"),
    `当前=${state?.current} · 已完成=${(state?.done ?? []).join(" / ") || "—"}`,
  );
  check(
    "页面上等你点的是「下一步：人工核验 4 条」，核验入口可用",
    (state?.buttons ?? []).includes("下一步：人工核验 4 条"),
    (state?.buttons ?? []).join(" | "),
  );

  /* ---------- ④ 8 步流水线：逐步给数 + 逐条命中 ---------- */
  const process = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.dc-process li')].map((li) => ({
      label: li.querySelector('.dc-process__copy b')?.textContent.trim() ?? '',
      detail: li.querySelector('.dc-process__copy small')?.textContent.trim() ?? '',
      hits: li.querySelector('.dc-process__hits')?.textContent.trim() ?? '',
      counts: li.querySelector('.dc-process__counts')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      chip: li.querySelector('.chip')?.textContent.trim() ?? '',
    }));
    const kpi = [...document.querySelectorAll('.dc-kpi li')].map((li) => ({
      key: li.querySelector('small')?.textContent.trim() ?? '',
      value: li.querySelector('b')?.textContent.trim() ?? '',
    }));
    const groups = document.querySelector('.dc-groups');
    return {
      rows,
      kpi,
      groupText: groups ? groups.textContent.replace(/\\s+/g, ' ').trim() : '',
      splits: groups ? [...groups.querySelectorAll('.dc-groups__list li')].map((li) => li.textContent.replace(/\\s+/g, ' ').trim()) : [],
    };
  })()`);

  check("清洗执行明细是 8 步流水线（比原来那张 4 步静态表更细）", process.rows.length === 8, process.rows.map((r) => r.label).join(" → "));
  check(
    "每一步都给出输入/保留/待核验三个数，且逐条列出命中的记录号",
    process.rows.every((r) => /输入 \d+ · 保留 \d+/.test(r.counts)) &&
      process.rows.filter((r) => r.chip === "待核验").length === 4,
    process.rows.map((r) => `${r.label}：${r.counts}｜${r.hits}`).join(" ／ "),
  );
  check(
    "漏斗在收敛：每一步的保留数不超过输入数",
    process.rows.every((r) => {
      const m = r.counts.match(/输入 (\d+) · 保留 (\d+)/);
      return m ? Number(m[2]) <= Number(m[1]) : false;
    }),
    process.rows.map((r) => r.counts).join(" ／ "),
  );

  const kpiOf = (key) => process.kpi.find((item) => item.key === key)?.value ?? "";
  check("执行清洗的四个口径：输入 12 / 保留 6 / 疑似异常项 4", kpiOf("输入") === "12" && kpiOf("保留") === "6" && kpiOf("疑似异常项") === "4", process.kpi.map((k) => `${k.key}=${k.value}`).join(" · "));

  const hitIds = process.rows
    .filter((r) => r.chip === "待核验")
    .flatMap((r) => (r.hits.match(/r-\d+/g) ?? []))
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .sort();
  check(
    "被规则挑出来的记录是 r-0003 / r-0007 / r-0008 / r-0009（与核验队列同一批）",
    JSON.stringify(hitIds) === JSON.stringify(["r-0003", "r-0007", "r-0008", "r-0009"]),
    hitIds.join(" / "),
  );
  check(
    "「确定不可用」的两条被直接剔除，不占用人工核验时间",
    process.rows.some((r) => r.label === "字段与空值检查" && /r-0005/.test(r.hits) && /r-0010/.test(r.hits) && /直接剔除/.test(r.hits)),
    process.rows.find((r) => r.label === "字段与空值检查")?.hits ?? "—",
  );

  /* ---------- ⑤ 分组与划分 ---------- */
  check(
    "分组与划分一段给出泄漏结论（当前种子无跨划分泄漏）",
    /无跨划分泄漏/.test(process.groupText),
    process.splits.join(" ／ "),
  );
  const splitCounts = process.splits.map((t) => Number((t.match(/记录 (\d+) 条/) ?? [])[1] ?? -1));
  check(
    "三个划分的记录数加起来等于清洗后的保留数（同一份结果，不是各写各的）",
    splitCounts.length === 3 && splitCounts.reduce((a, b) => a + b, 0) === Number(kpiOf("保留")),
    `${process.splits.join(" ／ ")} → 合计 ${splitCounts.reduce((a, b) => a + b, 0)}`,
  );
  check("清洗页不出现「深度」这类未标定的量（平台口径：不写深度）", !/深度/.test(state.text), "面板文案里没有「深度」");

  /* ---------- ⑥ 人工核验：脚本不替人点，人来点开 ---------- */
  await shot("数据清洗引导-流程");
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.dc-stage button')].find((el) => el.textContent.trim().startsWith('下一步：人工核验'));
    if (btn) btn.click();
    return Boolean(btn);
  })()`);
  let review = null;
  for (let i = 0; i < 40; i += 1) {
    review = await evaluate(`(() => {
      const list = document.querySelector('.dc-review');
      if (!list) return null;
      return [...list.querySelectorAll('li')].map((li) => ({
        recordId: li.querySelector('b')?.textContent.trim() ?? '',
        reason: li.querySelector('.dc-review__reason')?.textContent.trim() ?? '',
        value: li.querySelector('em')?.textContent.trim() ?? '',
        ops: [...li.querySelectorAll('button')].map((b) => b.textContent.trim()),
      }));
    })()`);
    if (review) break;
    await sleep(250);
  }
  check(
    "点「下一步：人工核验」后，核验弹窗逐条列出 4 条待核验记录",
    Array.isArray(review) && review.length === 4 && JSON.stringify(review.map((r) => r.recordId).sort()) === JSON.stringify(["r-0003", "r-0007", "r-0008", "r-0009"]),
    Array.isArray(review) ? review.map((r) => r.recordId).join(" / ") : "弹窗没出现",
  );
  check(
    "每条都写清「被哪条规则挑出来 + 命中值」，与流程明细里逐条对得上",
    Array.isArray(review) &&
      review.every((r) => {
        const row = process.rows.find((item) => item.hits.includes(r.recordId));
        if (!row || !r.reason || !r.value) return false;
        const rule = r.reason.split("·")[0].trim();
        return row.label === rule;
      }),
    Array.isArray(review) ? review.map((r) => `${r.recordId} ${r.reason} → ${r.value}`).join(" ／ ") : "—",
  );
  check(
    "每条都只能由人点「采纳 / 排除」（核验是人的责任）",
    Array.isArray(review) && review.every((r) => r.ops.join("") === "采纳排除"),
    Array.isArray(review) ? review[0].ops.join(" / ") : "—",
  );

  /* ---------- ⑦ 语音：真音频文件，没退回浏览器合成音 ---------- */
  const audio = await evaluate(`window.__audio`);
  check(
    "这一轮放的是音频文件（⑰ voicePack = AI语音5）",
    Array.isArray(audio?.played) && audio.played.length > 0,
    (audio?.played ?? []).map((u) => String(u).split("/").pop()).join(" / ") || "没有任何音频播放",
  );
  check("没有退回浏览器语音合成", (audio?.synth ?? 0) === 0, `speechSynthesis 调用 ${audio?.synth ?? 0} 次`);

  /* ---------- 存档一张核验弹窗的现场图 ---------- */
  await shot("数据清洗引导-核验");
} catch (error) {
  console.error(`  ✗ 工装自身出错：${error?.message ?? error}`);
  failed += 1;
} finally {
  chrome.kill();
}

console.log(failed === 0 ? "\n全部通过（⑰ 数据清洗 · 一步一步引导到人工核验）" : `\n${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
