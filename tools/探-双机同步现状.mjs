/**
 * 探：**内网多主机内容同步现状**（两台真浏览器，同一台服务器）
 *
 * 目的：把"哪些同步、哪些不同步"用实测列出来，而不是靠推断。
 * 用户口径：「项目就是面向结果展示的，但得做到内网多主机内容同步」。
 *
 * 两台机器：
 *   A = shi（演示机，人在这一台上按快捷键 / 说话）
 *   B = shen（另一台，看同一个内网地址）
 *
 * 判据分两类：
 *   ① **业务数据**：A 写的（建单、任务卡）B 能不能读到 —— 走服务端，理论上同步；
 *   ② **演示内容**：A 上的小木回合（台词 / 页面落点 / 浮层）B 能不能看到 ——
 *      这一层现在跑在**浏览器本地**（agent store + window 事件 + 本地路由），预期不同步。
 *
 * 用法：node --import ./tools/test-resolve-ts.mjs tools/探-双机同步现状.mjs [--url …]
 */

import { Machine, sleep } from "./browser-harness.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf("url", process.env.MUMAI_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");

const A = new Machine({ name: "sync-a", port: 9551, base: BASE, account: "shi" });
const B = new Machine({ name: "sync-b", port: 9552, base: BASE, account: "shen" });
let createdOrderId = null;

const hash = (m) => m.evaluate(`location.hash`);
const bubble = (m) =>
  m.evaluate(
    `(() => { const node = document.querySelector('.xd__answer') || document.querySelector('.xd'); return (node?.textContent || '').trim().slice(0, 40); })()`,
  );
const rows = [];
const note = (name, synced, detail) => {
  rows.push({ name, synced, detail });
  console.log(`  ${synced ? "同步" : "未同步"}  ${name}　（${detail}）`);
};

try {
  console.log(`双机同步现状 · ${BASE}`);
  await A.start();
  await B.start();
  if (!(await A.login())) throw new Error("A 登录失败（shi）");
  if (!(await B.login())) throw new Error("B 登录失败（shen）");
  console.log("  两台已登录（shi / shen）\n");

  /* ---------- ① 业务数据：A 建单，B 能不能看到 ---------- */
  const before = await B.call("GET", "/api/work-orders");
  const beforeCount = (before?.json?.orders ?? []).length;
  await A.evaluate(`window.dispatchEvent(new CustomEvent('mumai:build-order', { detail: {} })); 1`);
  /* 快捷键与页面内按钮同源：这里直接按 Ctrl+Q+L */
  await A.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2 });
  await A.send("Input.dispatchKeyEvent", { type: "keyDown", key: "q", code: "KeyQ", windowsVirtualKeyCode: 81, modifiers: 2 });
  await A.send("Input.dispatchKeyEvent", { type: "keyUp", key: "q", code: "KeyQ", windowsVirtualKeyCode: 81, modifiers: 2 });
  await sleep(250);
  await A.send("Input.dispatchKeyEvent", { type: "keyDown", key: "l", code: "KeyL", windowsVirtualKeyCode: 76, modifiers: 2 });
  await A.send("Input.dispatchKeyEvent", { type: "keyUp", key: "l", code: "KeyL", windowsVirtualKeyCode: 76, modifiers: 2 });
  await A.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 });

  let afterCount = beforeCount;
  for (let i = 0; i < 30; i += 1) {
    await sleep(500);
    const nowA = await A.call("GET", "/api/work-orders");
    const nowB = await B.call("GET", "/api/work-orders");
    afterCount = (nowB?.json?.orders ?? []).length;
    if (afterCount > beforeCount) {
      createdOrderId = (nowB.json.orders[0] ?? {}).id ?? null;
      break;
    }
    if (i === 29) {
      console.log(`    诊断：A 侧工单数=${(nowA?.json?.orders ?? []).length}（若 A 也没变，说明快捷键没生效）`);
    }
  }
  note("A 建单 → B 读到新工单", afterCount > beforeCount, `B 侧工单数 ${beforeCount} → ${afterCount}`);

  /* ---------- ② 业务数据：A 说 ⑥（生成任务卡），B 能不能读到 ---------- */
  const cardsBefore = (await B.call("GET", "/api/sessions/demo-01/snapshot"))?.json?.entities?.taskCard?.length ?? 0;
  await A.evaluate(
    `window.dispatchEvent(new CustomEvent('mumai:xiaomu-ask', { detail: { question: '同步工单任务', interactionId: 'sync-${Date.now()}' } })); 1`,
  );
  let cardsAfter = cardsBefore;
  for (let i = 0; i < 20; i += 1) {
    await sleep(500);
    cardsAfter = (await B.call("GET", "/api/sessions/demo-01/snapshot"))?.json?.entities?.taskCard?.length ?? 0;
    if (cardsAfter > cardsBefore) break;
  }
  note("A 触发⑥生成任务卡 → B 读到卡片", cardsAfter > cardsBefore, `B 侧任务卡 ${cardsBefore} → ${cardsAfter}`);

  /* ---------- ③ 演示内容：A 的小木回合，B 能不能看到 ---------- */
  await B.evaluate(`location.hash = '#/'`);
  await A.evaluate(`location.hash = '#/'`);
  await sleep(400);
  const hashBeforeB = await hash(B);
  const bubbleBeforeB = await bubble(B);
  await A.evaluate(
    `window.dispatchEvent(new CustomEvent('mumai:xiaomu-ask', { detail: { question: '清洗这批数据', interactionId: 'sync2-${Date.now()}' } })); 1`,
  );
  /*
    ⚠ 要等够：ask() 里先 enterThinking（2.5–4 秒）才回复与执行页面动作；
    上一版只等 3 秒，于是"A 自己跳了没有"都被判成未同步（假红）。
  */
  let hashA = "";
  for (let i = 0; i < 40; i += 1) {
    await sleep(300);
    hashA = await hash(A);
    if (String(hashA).includes("/firmware")) break;
  }
  const hashB = await hash(B);
  const bubbleAfterB = await bubble(B);
  const bubbleAfterA = await bubble(A);
  note("A 说⑰ → A 自己跳到数据集", String(hashA).includes("/firmware"), `A hash=${hashA} · A 气泡=${JSON.stringify(bubbleAfterA)}`);
  note("A 说⑰ → **B 的页面跟着跳**", String(hashB).includes("/firmware"), `B hash ${hashBeforeB} → ${hashB}`);
  note(
    "A 说⑰ → **B 出现同一句小木台词**",
    Boolean(bubbleAfterB) && bubbleAfterB !== bubbleBeforeB,
    `B 气泡 ${JSON.stringify(bubbleBeforeB)} → ${JSON.stringify(bubbleAfterB)}`,
  );

  /* ---------- ④ 演示内容：主动预警（⑬）在 B 上有没有 ---------- */
  await A.evaluate(`(() => {
    const fire = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, code: 'Key' + key.toUpperCase(), ctrlKey: true, bubbles: true, cancelable: true }));
    fire('y'); fire('3'); return true;
  })()`);
  const alertOnB = await B.waitFor(`Boolean(document.querySelector('.dsf--alert'))`, { timeoutMs: 5000 });
  note("A 按 Ctrl+Y+3（⑬ 主动预警）→ **B 弹出预警窗**", Boolean(alertOnB), `B 上预警窗=${Boolean(alertOnB)}`);

  /* ---------- ⑤ 投屏状态（服务端保存的那一份）在 B 上可读吗 ---------- */
  const projectionBefore = (await B.call("GET", "/api/sessions/demo-01/snapshot"))?.json?.projection ?? null;
  note(
    "投屏状态存在服务端（B 可读）",
    Boolean(projectionBefore),
    `B 读到 projection=${JSON.stringify(projectionBefore)?.slice(0, 80)}`,
  );

  console.log("\n小结：");
  const data = rows.filter((row) => row.name.includes("读到") || row.name.includes("可读"));
  const content = rows.filter((row) => !data.includes(row));
  console.log(`  业务数据类：${data.filter((r) => r.synced).length}/${data.length} 同步`);
  console.log(`  演示内容类：${content.filter((r) => r.synced).length}/${content.length} 同步`);
} catch (error) {
  console.error(`探针异常：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  /* 收工：删掉探针建的那张单（级联清任务卡），不给演示库留东西 */
  if (createdOrderId) {
    const removed = await A.call("DELETE", `/api/work-orders/${createdOrderId}`).catch(() => null);
    console.log(`  收工：删掉探针建的工单 ${createdOrderId}（HTTP ${removed?.status ?? "?"}）`);
  }
  A.kill();
  B.kill();
}
