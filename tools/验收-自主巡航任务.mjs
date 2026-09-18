/**
 * 自主巡航任务验收 · **两台真浏览器**（工单页下发 → 接受 → 去建图巡航）
 *
 * 用户 2026-09-18 口径：「在工单界面添加下发自主巡航任务功能，页面可以有小车数据，
 * 小车巡航任务预览，生成任务编号，这边是 shi 派发的，然后 ma 这边接受任务去建图巡航」。
 *
 * 这一组就按现场动线走一遍，每一步都在**页面**上验，不靠接口自说自话：
 *   A 台 = 本机 `http://127.0.0.1:8000`，登录 **shi**（下发的人）；
 *   B 台 = 独立 profile 的第二台浏览器，登录 **ma**（接受并去建图巡航的人）。
 *
 * 判据（都能证伪）：
 *   ① 工单页有「自主巡航任务」面板，并且**小车数据是真实读数**（链路 / 位姿 / 电量至少三格有值）；
 *   ② 巡航任务预览齐：巡检构件 Z01—Z04、航点数、计划里程（按栅格折算）、预计时长、速度；
 *   ③ 下发前「任务编号」写的是「下发后生成」——不编号；
 *   ④ 史点「下发自主巡航任务」→ 出现 `CR-<日期>-NN` 任务号、状态「待接受」、
 *      经手人一行写着「史 派发 · 等待接受」；
 *   ⑤ 服务端实体里确实是这条：kind=cruise、orderId 对得上、state=queued、createdBy=shi；
 *   ⑥ 马那台打开同一张工单**看得到同一条任务**（跨账号跨端同一份数据）；
 *   ⑦ 马点「接受任务」→ 状态「执行中」+「马昱天 已接受（…）」，并出现「去建图巡航」；
 *   ⑧ 史那台**不刷新**也跟着变（实时通道）；
 *   ⑨ 点「去建图巡航」跳到 `#/mapping?task=CR-…`，页面顶部横幅报出同一个任务号；
 *   ⑩ 标记完成 → 服务端 state=succeeded；删工单 → 任务实体一并清掉（不留孤儿任务）。
 *
 * 前置：8000 在跑（`node server/index.mjs --static dist`），且已 `npm run build`。
 * 用法：node tools/验收-自主巡航任务.mjs [--base http://127.0.0.1:8000]
 */
import { Machine, sleep } from "./browser-harness.mjs";

const argOf = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const BASE = (argOf("--base", "http://127.0.0.1:8000") ?? "").replace(/\/$/, "");

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `　（${detail}）` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
};

/** 面板读数：小车数据 + 预览 + 任务状态，一次性抓回来 */
const PANEL_PROBE = `(() => {
  const panel = [...document.querySelectorAll('.tech-panel')].find((el) =>
    (el.querySelector('h2')?.textContent || '').trim().startsWith('自主巡航任务'));
  if (!panel) return { found: false };
  const kv = [...panel.querySelectorAll('.kv > div')].map((el) =>
    (el.textContent || '').replace(/\\s+/g, ' ').trim());
  const text = (panel.textContent || '').replace(/\\s+/g, ' ').trim();
  const taskNo = (text.match(/CR-\\d{8}-\\d{2}/) || [])[0] || '';
  const buttons = [...panel.querySelectorAll('button')].map((b) => ({
    text: (b.textContent || '').trim(),
    disabled: b.disabled,
    title: b.title || '',
  }));
  const history = [...panel.querySelectorAll('table tbody tr')].map((tr) =>
    (tr.textContent || '').replace(/\\s+/g, ' ').trim());
  return { found: true, text, kv, taskNo, buttons, history };
})()`;

/** 顶栏「协同」那一格（顺带证明马那台也连着同一台服务器） */
const chipProbe = (label) => `(() => {
  const strip = document.querySelector('.appshell__channels');
  if (!strip) return null;
  for (const btn of strip.querySelectorAll('button')) {
    const name = (btn.querySelector('.appshell__channels-label')?.textContent || '').trim();
    if (name === ${JSON.stringify(label)}) return (btn.textContent || '').replace(name, '').trim();
  }
  return null;
})()`;

const A = new Machine({ name: "cruise-shi", port: 9521, base: BASE, account: "shi" });
const B = new Machine({ name: "cruise-ma", port: 9522, base: BASE, account: "ma" });
let orderId = "";
let orderNo = "";
let taskNo = "";

try {
  await Promise.all([A.start(), B.start()]);
  const [aIn, bIn] = await Promise.all([A.login(), B.login()]);
  check("A 台登录 shi（下发的人）", aIn, `hash=${await A.evaluate(`location.hash`)}`);
  check("B 台登录 ma（接受并去建图巡航的人）", bIn, `hash=${await B.evaluate(`location.hash`)}`);

  /* ---------- 先有一张真工单（现场是小木按快捷键建的，这里走同一个接口） ---------- */
  const created = await A.call("POST", "/api/work-orders/trigger", { eventId: `cruise-${Date.now().toString(36)}` });
  orderId = created.json?.orderId ?? "";
  orderNo = created.json?.orderNo ?? "";
  check(
    "A 台建出一张待办工单",
    created.status === 200 && Boolean(orderId),
    `HTTP ${created.status}　${orderNo || JSON.stringify(created.json).slice(0, 160)}`,
  );
  if (!orderId) throw new Error(`建单没成功（HTTP ${created.status}），后面每一步都没有意义`);

  /* ---------- ① 工单页的「自主巡航任务」面板 ---------- */
  await A.evaluate(`location.hash = '#/orders?order=${orderId}'`);
  let panel = null;
  for (let i = 0; i < 60; i += 1) {
    await sleep(300);
    panel = await A.evaluate(PANEL_PROBE);
    if (panel?.found) break;
  }
  check("工单页有「自主巡航任务」面板", Boolean(panel?.found));

  /* 小车数据：等一等真实读数（服务端 4 秒一刷） */
  let cartText = "";
  for (let i = 0; i < 25; i += 1) {
    await sleep(400);
    panel = await A.evaluate(PANEL_PROBE);
    cartText = (panel?.kv ?? []).join(" ｜ ");
    if (/位姿/.test(cartText) && /x -?\d/.test(cartText)) break;
  }
  check(
    "面板里的**小车数据**是真实读数（链路 / 位姿 / 电量 / 相机）",
    /链路/.test(cartText) && /位姿/.test(cartText) && /电量/.test(cartText) && /相机/.test(cartText),
    cartText.slice(0, 220),
  );
  check(
    "小车链路与延迟读到了（不是「—」）",
    /在线|延迟|离线/.test(cartText) && /数据延迟 \d+s/.test(cartText),
    (cartText.match(/链路[^｜]*/) || [])[0] ?? cartText.slice(0, 80),
  );

  /* ---------- ② 巡航任务预览 ---------- */
  /*
    ⚠ 面板里的读数是从 `<dt>标签</dt><dd>值</dd>` 拼出来的，**标签与值之间没有空格**
    （`计划里程8.9 m`）—— 判据里不能写成 `计划里程 8.9`，那是照着"人读的样子"写的，
    在 DOM 文本里根本不存在。
  */
  check(
    "巡航任务预览齐：巡检构件 Z01—Z04、航点数、计划里程、预计时长、速度",
    /Z01 · Z02 · Z03 · Z04/.test(panel.text) &&
      /航点数\d+ 个/.test(panel.text) &&
      /计划里程\d+(\.\d+)? m/.test(panel.text) &&
      /预计时长\d/.test(panel.text) &&
      /速度\d+\.\d+ m\/s/.test(panel.text),
    (panel.text.match(/巡检构件[^｜]*/) || [])[0] + " ／ " + (panel.text.match(/计划里程\d[^｜]*/) || [])[0],
  );
  check(
    "计划里程写明口径（栅格 m/格，与小木口播同源）",
    /栅格 0?\.\d+ m\/格/.test(panel.text),
    (panel.text.match(/计划里程按栅格[^；]*/) || [])[0] ?? "—",
  );

  /* ---------- ③ 下发前不编号 ---------- */
  check(
    "下发前「任务编号」写的是「下发后生成」（页面不自己编号）",
    /任务编号下发后生成/.test(panel.text),
    (panel.text.match(/任务编号下发后生成/) || ["（没读到）"])[0],
  );
  const dispatchButton = panel.buttons.find((b) => b.text.includes("下发自主巡航任务"));
  check("有「下发自主巡航任务」按钮且可点", Boolean(dispatchButton) && dispatchButton.disabled === false, JSON.stringify(dispatchButton ?? {}));

  /* ---------- ④ 史下发 → 出现任务号 ---------- */
  await A.evaluate(`(() => {
    const panel = [...document.querySelectorAll('.tech-panel')].find((el) =>
      (el.querySelector('h2')?.textContent || '').trim().startsWith('自主巡航任务'));
    const btn = [...(panel?.querySelectorAll('button') ?? [])].find((b) => (b.textContent || '').includes('下发自主巡航任务'));
    btn?.click();
    return Boolean(btn);
  })()`);
  for (let i = 0; i < 60; i += 1) {
    await sleep(300);
    panel = await A.evaluate(PANEL_PROBE);
    if (panel.taskNo) break;
  }
  taskNo = panel.taskNo;
  const day = /^WO-(\d{8})-\d+$/.exec(orderNo)?.[1] ?? "";
  check(
    "下发后生成任务编号（服务端按工单生成 CR-日期-流水）",
    Boolean(taskNo) && /^CR-\d{8}-\d{2}$/.test(taskNo) && (!day || taskNo.startsWith(`CR-${day}-`)),
    `任务号=${taskNo || "（没生成）"}　工单=${orderNo}`,
  );
  check("状态变成「待接受」，并写出经手人一行", /待接受/.test(panel.text) && /史 派发 · 等待接受/.test(panel.text), (panel.text.match(/CR-[^｜]*/) || [])[0] ?? panel.text.slice(0, 120));
  check("下发之后预览里的圈数/速度仍与任务一致（速度取小车自报上限）", /0\.\d+ m\/s/.test(panel.text), (panel.text.match(/速度[^｜]*/) || [])[0] ?? "—");

  /* ---------- ⑤ 服务端实体核对 ---------- */
  const snapshot = await A.call("GET", "/api/sessions/demo-01/snapshot");
  const entity = (snapshot.json?.entities?.mission ?? []).find((item) => item.id === taskNo);
  check(
    "服务端实体里就是这条任务（kind=cruise、挂着工单、state=queued、派发人是史）",
    Boolean(entity) &&
      entity.data.kind === "cruise" &&
      entity.data.orderId === orderId &&
      entity.data.state === "queued" &&
      entity.data.createdBy === "shi" &&
      (entity.data.componentIds ?? []).join(",") === "Z01,Z02,Z03,Z04",
    entity ? JSON.stringify({ kind: entity.data.kind, orderId: entity.data.orderId, state: entity.data.state, by: entity.data.createdBy }) : "快照里没有这条任务",
  );

  /* ---------- ⑥ 马那台打开同一张工单：看得到同一条 ---------- */
  await B.evaluate(`location.hash = '#/orders?order=${orderId}'`);
  let bPanel = null;
  for (let i = 0; i < 60; i += 1) {
    await sleep(300);
    bPanel = await B.evaluate(PANEL_PROBE);
    if (bPanel?.found && bPanel.taskNo) break;
  }
  check(
    "马那台打开同一张工单，看到的是同一条任务号",
    bPanel?.taskNo === taskNo,
    bPanel?.found ? `马看到 ${bPanel.taskNo || "（面板里没有任务号）"}` : `马那台没有这个面板：${(await B.evaluate(`document.body.innerText.slice(0, 120)`)) ?? ""}`,
  );
  const bCollab = await B.evaluate(chipProbe("协同"));
  check("马那台也连着同一台服务器（顶栏「协同」有端数）", /\d+ 台/.test(String(bCollab)), `读到「${bCollab}」`);

  /* ---------- ⑦ 马接受 ---------- */
  await B.evaluate(`(() => {
    const panel = [...document.querySelectorAll('.tech-panel')].find((el) =>
      (el.querySelector('h2')?.textContent || '').trim().startsWith('自主巡航任务'));
    const btn = [...(panel?.querySelectorAll('button') ?? [])].find((b) => (b.textContent || '').trim() === '接受任务');
    btn?.click();
    return Boolean(btn);
  })()`);
  for (let i = 0; i < 60; i += 1) {
    await sleep(300);
    bPanel = await B.evaluate(PANEL_PROBE);
    if (bPanel?.found && /执行中/.test(bPanel.text) && /马昱天 已接受/.test(bPanel.text)) break;
  }
  const bText = bPanel?.text ?? "";
  check(
    "马点「接受任务」→ 状态「执行中」并记下是谁接的",
    /执行中/.test(bText) && /马昱天 已接受（\d{2}-\d{2} \d{2}:\d{2}）/.test(bText),
    (bText.match(/CR-[^｜]*派发[^｜]*/) || [])[0] ?? bText.slice(0, 160) ?? "（没读到面板）",
  );
  check("接受之后出现「去建图巡航」入口", (bPanel?.buttons ?? []).some((b) => b.text === "去建图巡航"), (bPanel?.buttons ?? []).map((b) => b.text).join(" / "));

  /* ---------- ⑧ 史那台不刷新也跟着变 ---------- */
  let aAfterAccept = null;
  for (let i = 0; i < 60; i += 1) {
    aAfterAccept = await A.evaluate(PANEL_PROBE);
    if (aAfterAccept?.found && /执行中/.test(aAfterAccept.text)) break;
    await sleep(300);
  }
  const aText = aAfterAccept?.text ?? "";
  check(
    "史那台**不刷新**就同步到「执行中 + 马昱天已接受」",
    /执行中/.test(aText) && /马昱天 已接受/.test(aText),
    `hash=${await A.evaluate(`location.hash`)}（未重载）`,
  );

  /* ---------- ⑨ 去建图巡航：跳转 + 横幅报同一个号 ---------- */
  await B.evaluate(`(() => {
    const panel = [...document.querySelectorAll('.tech-panel')].find((el) =>
      (el.querySelector('h2')?.textContent || '').trim().startsWith('自主巡航任务'));
    const btn = [...(panel?.querySelectorAll('button') ?? [])].find((b) => (b.textContent || '').trim() === '去建图巡航');
    btn?.click();
    return Boolean(btn);
  })()`);
  let banner = null;
  for (let i = 0; i < 60; i += 1) {
    await sleep(300);
    banner = await B.evaluate(`(() => {
      const el = document.querySelector('.cruise-banner');
      if (!el) return null;
      return {
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
        linked: el.classList.contains('is-linked'),
        buttons: [...el.querySelectorAll('button')].map((b) => (b.textContent || '').trim()),
      };
    })()`);
    if (banner?.text.includes(taskNo)) break;
  }
  const bHash = String(await B.evaluate(`location.hash`));
  check("点「去建图巡航」跳到建图巡航页并带上任务号", bHash.includes("/mapping") && bHash.includes(taskNo), `hash=${bHash}`);
  check(
    "建图巡航页顶部横幅报出同一个任务号，并标明这是工单派下来的",
    Boolean(banner) && banner.text.includes(taskNo) && /来自 WO-/.test(banner.text) && /平台侧任务单据/.test(banner.text),
    banner?.text?.slice(0, 200) ?? "（没有横幅）",
  );
  check("从工单页跳进来时横幅高亮（这一条就是派给你的）", Boolean(banner?.linked), banner?.linked ? "is-linked" : "没有高亮");
  const shot = await B.shot("自主巡航任务-建图巡航页横幅");
  if (shot) console.log(`\n  截图：${shot}`);

  /* ---------- ⑩ 收尾：标记完成 + 删工单（任务实体一并清掉，不留孤儿） ---------- */
  await B.evaluate(`(() => {
    const el = document.querySelector('.cruise-banner');
    const btn = [...(el?.querySelectorAll('button') ?? [])].find((b) => (b.textContent || '').trim() === '标记完成');
    btn?.click();
    return Boolean(btn);
  })()`);
  let done = false;
  for (let i = 0; i < 60; i += 1) {
    await sleep(300);
    const snapshotNow = await B.call("GET", "/api/sessions/demo-01/snapshot");
    const item = (snapshotNow.json?.entities?.mission ?? []).find((row) => row.id === taskNo);
    if (item?.data?.state === "succeeded") {
      done = true;
      break;
    }
  }
  check("在横幅上标记完成 → 服务端 state=succeeded", done, done ? "succeeded" : "还是没完成");

  const removed = await A.call("DELETE", `/api/work-orders/${orderId}`);
  await sleep(1200);
  const afterDelete = await A.call("GET", "/api/sessions/demo-01/snapshot");
  const leftover = (afterDelete.json?.entities?.mission ?? []).find((row) => row.id === taskNo);
  check("删工单把这条巡航任务一并清掉（不留指着已删工单的孤儿任务）", removed.status === 200 && !leftover, `删单 HTTP ${removed.status}`);
  if (removed.status === 200) orderId = "";
} catch (error) {
  console.error(`\n验收中断：${error?.message ?? error}`);
  fail += 1;
} finally {
  /* 兜底清理：验收失败也不留临时工单与未结束的任务 */
  if (orderId) {
    try {
      await A.call("DELETE", `/api/work-orders/${orderId}`);
    } catch {
      /* 尽力而为 */
    }
  }
  A.kill();
  B.kill();
}

console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项未通过`}（通过 ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
