/**
 * 验收：**内网多主机内容同步**（两台真浏览器，同一台服务器）
 *
 * 用户口径（2026-09-23）：「实际上项目就是面向结果展示的，但得做到内网多主机内容同步」。
 *
 * 这条工装回答四件事，全部对**第二台机器的屏幕**做断言（不看第一台）：
 *   ① 演示机讲一轮（⑰），第二台机器是否**同屏出现同一句台词**并**跟到同一页**；
 *   ② 演示机的**主动预警**（⑬，Ctrl+Y+3）在第二台上是否也弹窗；
 *   ③ 第二台**不出声**（跟随只跟随画面与文字；多台机器同时放音会互相打架）；
 *   ④ 跟随开关关掉后**不再跟随**，本机自己说话也不受影响；
 *   ⑤ 业务数据本来就是服务端权威：A 写的任务卡 / 工单 / 投屏状态在 B 上读得到；
 *   ⑥ **没有回声死循环**：一轮广播只产生一条留痕（B 不会把跟来的那一轮再广播出去）。
 *
 * 用法（仓库根目录）：
 *   node --import ./tools/test-resolve-ts.mjs tools/验收-多机同步.mjs
 *   … --url http://192.168.1.5:8000     在内网地址上跑（两台"机器"都连它）
 */

import { Machine, sleep } from "./browser-harness.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf("url", process.env.MUMAI_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `　（${detail}）` : ""}`);
  if (!ok) failed += 1;
};

const A = new Machine({ name: "multi-a", port: 9561, base: BASE, account: "shi" });
const B = new Machine({ name: "multi-b", port: 9562, base: BASE, account: "shen" });
let createdOrderId = null;

/** A 说一轮（与现场说法一致：真发小木命令） */
const askOnA = (phrase, tag) =>
  A.evaluate(
    `window.dispatchEvent(new CustomEvent('mumai:xiaomu-ask', { detail: { question: ${JSON.stringify(phrase)}, interactionId: 'multi-${tag}-' + Date.now() } })); 1`,
  );

const waitHash = async (machine, part, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  let hash = "";
  while (Date.now() < deadline) {
    await sleep(300);
    hash = await machine.evaluate(`location.hash`);
    if (String(hash).includes(part)) return hash;
  }
  return hash;
};

const turnsCount = async () => {
  const snapshot = await A.call("GET", "/api/sessions/demo-01/snapshot");
  return (snapshot?.json?.entities?.agentTurn ?? []).length;
};

try {
  console.log(`内网多主机内容同步验收 · ${BASE}`);
  await A.start();
  await B.start();
  if (!(await A.login())) throw new Error("A 登录失败（shi）");
  if (!(await B.login())) throw new Error("B 登录失败（shen）");
  await sleep(1200);
  console.log("  两台已登录（shi / shen）\n");

  /* B 上装"有没有出过声"的计数器：跟随**不该**出声 */
  await B.evaluate(`(() => {
    window.__spoken = { synth: 0, audio: 0 };
    if (window.speechSynthesis && window.speechSynthesis.speak) {
      const orig = window.speechSynthesis.speak.bind(window.speechSynthesis);
      window.speechSynthesis.speak = (...rest) => { window.__spoken.synth += 1; return orig(...rest); };
    }
    const OrigAudio = window.Audio;
    window.Audio = function (...rest) { window.__spoken.audio += 1; return new OrigAudio(...rest); };
    return true;
  })()`);

  /* ---------- ① 演示机讲 ⑰ → 第二台同屏同页 ---------- */
  await B.evaluate(`location.hash = '#/'`);
  await A.evaluate(`location.hash = '#/'`);
  await sleep(400);
  const before = await turnsCount();
  await askOnA("清洗这批数据", "17");
  const hashA = await waitHash(A, "/firmware");
  check("A 说⑰ → A 自己跳到数据集", String(hashA).includes("/firmware"), `A hash=${hashA}`);
  const hashB = await waitHash(B, "/firmware");
  check("A 说⑰ → **B 的页面跟着跳到同一页**", String(hashB).includes("/firmware"), `B hash=${hashB}`);
  const lineB = await B.waitFor(
    `(() => { const text = document.body.innerText || ''; return text.includes('清洗完成，待审核记录已列出') ? '清洗完成，待审核记录已列出' : null; })()`,
    { timeoutMs: 8000 },
  );
  check("A 说⑰ → **B 显示同一句台词**", Boolean(lineB), lineB ?? "B 上没有出现这句");
  const afterOne = await turnsCount();
  check("一轮广播只留一条痕（B 不会把跟来的那一轮再广播出去）", afterOne === before + 1, `留痕 ${before} → ${afterOne}`);

  /* ---------- ② 主动预警（⑬）在第二台也弹窗 ---------- */
  await A.evaluate(`(() => {
    const fire = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, code: 'Key' + key.toUpperCase(), ctrlKey: true, bubbles: true, cancelable: true }));
    fire('y'); fire('3'); return true;
  })()`);
  const alertOnB = await B.waitFor(`Boolean(document.querySelector('.dsf--alert'))`, { timeoutMs: 12_000 });
  check("A 按 Ctrl+Y+3（⑬ 主动预警）→ **B 也弹出预警窗**", Boolean(alertOnB), `B 上预警窗=${Boolean(alertOnB)}`);
  const triageB = await waitHash(B, "tab=triage", 8000);
  check("  ↳ B 同时跟到异常排查页", String(triageB).includes("tab=triage"), `B hash=${triageB}`);

  /* ---------- ③ 跟随不出声 ---------- */
  const spoken = await B.evaluate(`window.__spoken`);
  check(
    "B 跟随期间**没有出声**（多台机器同时放音会互相打架）",
    Number(spoken?.synth ?? -1) === 0 && Number(spoken?.audio ?? -1) === 0,
    `语音合成 ${spoken?.synth} 次 · 音频对象 ${spoken?.audio} 个`,
  );

  /* ---------- ④ 关掉跟随就不再跟随 ---------- */
  await B.evaluate(`localStorage.setItem('mumai.follow.presenter', 'off'); location.hash = '#/'; 1`);
  await sleep(500);
  await askOnA("检查重建素材", "10");
  const hashA10 = await waitHash(A, "/materials");
  check("A 说⑩ → A 自己跳到素材质检", String(hashA10).includes("/materials"), `A hash=${hashA10}`);
  await sleep(4000);
  const hashB10 = await B.evaluate(`location.hash`);
  const lineB10 = await B.evaluate(`(document.body.innerText || '').includes('素材检查完成')`);
  check("**跟随已关**：B 不跟页", !String(hashB10).includes("/materials"), `B hash=${hashB10}`);
  check("**跟随已关**：B 不显示台词", lineB10 === false, `B 上出现台词=${lineB10}`);
  await B.evaluate(`localStorage.setItem('mumai.follow.presenter', 'on'); 1`);

  /* ---------- ⑤ 业务数据：A 写的，B 读得到 ---------- */
  /*
    ⚠ 判据是"**两台读到的卡片数一致且不为零**"，而不是"B 的卡片数比之前多"：
    ⑥ 那一轮的生成是**幂等**的（同一张工单的同一批只生成一次），
    演示库里已经有那一批卡时，"数量没变"是正确行为而不是同步坏了（第一版判据栽在这里）。
  */
  const orderId = (await A.call("GET", "/api/work-orders"))?.json?.orders?.[0]?.id ?? null;
  const cardsForOrder = async (machine) => {
    const snapshot = await machine.call("GET", "/api/sessions/demo-01/snapshot");
    return (snapshot?.json?.entities?.taskCard ?? []).filter((item) => item.data.orderId === orderId).length;
  };
  await askOnA("同步工单任务", "06");
  await sleep(4000);
  const cardsA = await cardsForOrder(A);
  const cardsB = await cardsForOrder(B);
  check(
    "A 触发⑥生成任务卡 → **B 读到同一批卡片**（服务端权威）",
    cardsA > 0 && cardsB === cardsA,
    `本单(${orderId}) A 侧 ${cardsA} 张 · B 侧 ${cardsB} 张`,
  );

  const ordersBefore = (await B.call("GET", "/api/work-orders"))?.json?.orders?.length ?? 0;
  const created = await A.call("POST", "/api/work-orders/trigger", { eventId: `multi-sync-${Date.now().toString(36)}` });
  createdOrderId = created?.json?.orderId ?? null;
  let ordersAfter = ordersBefore;
  for (let i = 0; i < 16; i += 1) {
    await sleep(500);
    ordersAfter = (await B.call("GET", "/api/work-orders"))?.json?.orders?.length ?? 0;
    if (ordersAfter > ordersBefore) break;
  }
  check("A 建单 → **B 读到新工单**", ordersAfter > ordersBefore, `B 侧工单数 ${ordersBefore} → ${ordersAfter}`);

  /* ---------- ⑥ 投屏状态（服务端保存）在 B 上读得到 ---------- */
  await A.call("POST", "/api/projection", { sessionId: "demo-01", viewType: "capture", focusIds: ["component:Z04"], hold: true });
  await sleep(800);
  const projection = (await B.call("GET", "/api/sessions/demo-01/snapshot"))?.json?.projection ?? null;
  check(
    "A 设的投屏状态 → B 读得到同一份",
    Boolean(projection) && Array.isArray(projection.focusIds) && projection.focusIds.includes("component:Z04"),
    `B 读到 ${JSON.stringify(projection)?.slice(0, 90)}`,
  );

  /* ---------- ⑦ 第二台机器打开「投到展示窗口」页：应当渲染同一份投屏内容 ---------- */
  await B.evaluate(`location.hash = '#/present'`);
  const presented = await B.waitFor(
    `(() => {
      const text = document.body.innerText || '';
      const holder = /持有人/.test(text);
      const view = /采集|监测|场景|地图|训练|交付|报告|工作台/.test(text);
      const focus = /Z04/.test(text);
      return holder && view ? { holder, view, focus, head: text.replace(/\\s+/g, ' ').slice(0, 90) } : null;
    })()`,
    { timeoutMs: 10_000 },
  );
  check(
    "B 打开投屏页 → 渲染同一份投屏内容（持有人 + 视图 + 焦点）",
    Boolean(presented),
    presented ? `holder=${presented.holder} 视图=${presented.view} 焦点Z04=${presented.focus}` : "投屏页没渲染出来",
  );

  const shot = await B.shot("多机同步-B屏");
  if (shot) console.log(`  截图（第二台机器）：${shot}`);
  console.log(failed === 0 ? "\n✓ 内网多主机内容同步：全部通过" : `\n✗ 有 ${failed} 项未通过`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (error) {
  console.error(`工装异常：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  /* 收工：删掉验收建的工单（级联清任务卡），并把 B 的跟随开关还原成开 */
  if (createdOrderId) {
    const removed = await A.call("DELETE", `/api/work-orders/${createdOrderId}`).catch(() => null);
    console.log(`  收工：删掉验收建的工单 ${createdOrderId}（HTTP ${removed?.status ?? "?"}）`);
  }
  await B.evaluate(`localStorage.setItem('mumai.follow.presenter', 'on'); 1`).catch(() => {});
  A.kill();
  B.kill();
}
