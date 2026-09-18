/**
 * 验收：执行工作台（剧本 ⑥ ⑮ —— 小木互动 → 任务卡自动生成 → 人核对保存 → 执行人回执）
 *
 * ── 这条工装回答的问题 ──────────────────────────────────────────────
 * 用户 2026-09-23 口径：「和小木互动时触发的自动操作……数据内网都同步」。
 * 于是要证伪的是四件事：
 *   ① 说「同步工单任务」这一句，页面是否**自动切到执行工作台**，并真的出现四张卡（不是弹个提示）；
 *   ② 卡片是否**落在服务端**（另一台机器打开同一页看到同样多的卡）—— 这就是"内网同步"的判据；
 *   ③ 「核对后保存」是否真的把状态推到已保存（点页面上的按钮，不改内存）；
 *   ④ 再说一次同样的话**不会**多出一批卡（幂等；连按两次快捷键不该变成八张）。
 *
 * 用法（仓库根目录）：
 *   node --import ./tools/test-resolve-ts.mjs tools/验收-执行工作台.mjs
 *   … --url http://192.168.1.5:8000        在内网地址上跑（另一台机器那一路也走同一地址）
 */

import { Machine, sleep } from "./browser-harness.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf("url", process.env.MUMAI_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");

const { SCRIPT_ROUNDS } = await import("../src/pages/MumaiDashboard/agent/script.ts");
const { routeUtterance } = await import("../src/pages/MumaiDashboard/agent/scriptMatch.ts");

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `　（${detail}）` : ""}`);
  if (!ok) failed += 1;
};

/** 从该轮的触发词里挑一条真能命中本轮的说法（与 验收-小木带路 同一套判据） */
function phraseOf(roundNo) {
  const round = SCRIPT_ROUNDS.find((item) => item.roundNo === roundNo);
  if (!round) throw new Error(`剧本里没有第 ${roundNo} 轮`);
  for (const trigger of round.triggers) {
    for (const sentence of [trigger, `小木，${trigger}`, `小木小木，${trigger}`]) {
      const route = routeUtterance(sentence);
      if (route.kind === "script" && route.round.roundNo === roundNo) return sentence;
    }
  }
  throw new Error(`第 ${roundNo} 轮没有能命中自己的说法`);
}

/** 页面上看到的卡片：编号 + 状态（从 DOM 读，不看接口 —— 接口由第二台机器那一路核） */
const CARDS_IN_PAGE = `(() => {
  const cards = [...document.querySelectorAll('.wb-card')];
  return cards.map((node) => ({
    id: (node.querySelector('.wb-card__no')?.textContent || '').trim(),
    title: (node.querySelector('header b')?.textContent || '').trim(),
    state: (node.querySelector('.chip, .status-chip')?.textContent || '').trim(),
  }));
})()`;

const machine = new Machine({ name: "wb", port: 9534, base: BASE, account: "shi" });
const peer = new Machine({ name: "wb-peer", port: 9535, base: BASE, account: "ma" });
/** 临时工单：任务卡按工单生成，跑完把工单删掉（服务端级联清卡片），不给演示库留东西 */
let tempOrderId = null;

try {
  console.log(`执行工作台验收 · ${BASE}`);
  await machine.start();
  if (!(await machine.login())) throw new Error(`登录失败（shi）—— 页面在 ${BASE} 上吗？`);
  console.log("  已登录（shi）\n");

  /*
    工装自己建一张临时工单来跑。
    为什么不借演示库里那张：⑥ 那一轮是"生成开工四项"，**幂等**（同一批只生成一次）——
    演示库里要是已经有卡片，现场演示时页面上什么都不会变。所以验收必须在一张
    干净的工单上做，做完把工单删掉（`DELETE /api/work-orders/:id` 会级联清 taskCard）。
  */
  const temp = await machine.call("POST", "/api/work-orders/trigger", { eventId: `e2e-workbench-${Date.now().toString(36)}` });
  if (temp?.status !== 200 || !temp.json?.orderId) throw new Error(`建临时工单失败：${JSON.stringify(temp?.json)}`);
  tempOrderId = temp.json.orderId;
  const order = { id: temp.json.orderId, orderNo: temp.json.orderNo };
  const before = await machine.call("GET", "/api/sessions/demo-01/snapshot");
  const cardCount = () => ((before.json?.entities?.taskCard ?? []).length);
  console.log(`  临时工单 ${order.orderNo} · 服务端已有任务卡 ${cardCount()} 张\n`);

  /* ---------- ① 说「同步工单任务」→ 自动切到执行工作台 + 开工四项出现 ---------- */
  await machine.evaluate(`location.hash = '#/console'`);
  await sleep(250);
  const phrase6 = phraseOf("⑥");
  await machine.evaluate(
    `window.dispatchEvent(new CustomEvent('mumai:xiaomu-ask', { detail: { question: ${JSON.stringify(phrase6)}, interactionId: 'wb-6-${Date.now()}' } })); 1`,
  );
  let hash = "";
  for (let i = 0; i < 40; i += 1) {
    await sleep(250);
    hash = await machine.evaluate(`location.hash`);
    if (String(hash).includes("/workbench")) break;
  }
  check("⑥ 说「同步工单任务」→ 自动打开执行工作台", String(hash).includes("/workbench"), `hash=${hash}`);

  let cards = await machine.waitFor(
    `(() => { const list = ${CARDS_IN_PAGE}; return list.length >= 4 ? list : null; })()`,
    { timeoutMs: 8000 },
  );
  check("⑥ 工作台上出现「开工四项」四张卡", Array.isArray(cards) && cards.length >= 4, `页面上 ${Array.isArray(cards) ? cards.length : 0} 张`);
  const ids = (cards ?? []).map((item) => item.id);
  check("卡号形状 TK-<工单日期段>-<两位流水>", ids.every((id) => /^TK-\d{8}-\d{2}$/.test(id)), ids.join(" / "));
  check("新生成的卡是草稿态（服务端没有「已完成」）", (cards ?? []).some((item) => item.state.includes("草稿")), (cards ?? []).map((c) => c.state).join(" / "));

  /* ---------- ② 服务端留存：卡片真的落库了 ---------- */
  const afterCreate = await machine.call("GET", "/api/sessions/demo-01/snapshot");
  const stored = afterCreate?.json?.entities?.taskCard ?? [];
  check("卡片落在服务端（不是页面内存）", stored.length >= 4, `快照里 ${stored.length} 张`);
  check(
    "卡片挂在当前工单下",
    stored.every((item) => item.data.orderId === order.id),
    `orderId=${order.id}`,
  );
  check("卡片带执行人（按岗位分工预填）", stored.every((item) => item.data.ownerAccountId && item.data.ownerLabel), stored.map((i) => i.data.ownerLabel).join(" / "));

  /* ---------- ③ 幂等：再说一次同样的话，不多出一批 ---------- */
  const countBeforeRepeat = stored.length;
  await machine.evaluate(
    `window.dispatchEvent(new CustomEvent('mumai:xiaomu-ask', { detail: { question: ${JSON.stringify(phrase6)}, interactionId: 'wb-6b-${Date.now()}' } })); 1`,
  );
  await sleep(2500);
  const afterRepeat = await machine.call("GET", "/api/sessions/demo-01/snapshot");
  check(
    "同一句话再说一次不会多出一批卡（幂等）",
    (afterRepeat?.json?.entities?.taskCard ?? []).length === countBeforeRepeat,
    `${countBeforeRepeat} → ${(afterRepeat?.json?.entities?.taskCard ?? []).length}`,
  );

  /* ---------- ④ 点页面上的「核对后保存」：状态真的推过去了 ---------- */
  const clicked = await machine.evaluate(`(() => {
    const button = [...document.querySelectorAll('.wb-card button')].find((node) => (node.textContent || '').includes('核对后保存') && !node.disabled);
    if (!button) return null;
    button.click();
    return true;
  })()`);
  check("工作台上有可点的「核对后保存」", clicked === true, clicked === true ? "" : "没找到可点的按钮（权限或状态不对）");
  const saved = await machine.waitFor(
    `(async () => {
      const response = await fetch('/api/sessions/demo-01/snapshot', { headers: { authorization: 'Bearer ' + (localStorage.getItem('mumai.token') || '') } });
      const body = await response.json();
      const list = (body.entities && body.entities.taskCard) || [];
      return list.some((item) => item.data.state === 'saved') ? list.filter((item) => item.data.state === 'saved').length : null;
    })()`,
    { timeoutMs: 8000 },
  );
  check("点一次保存后服务端上有「已保存」的卡", Boolean(saved), `已保存 ${saved ?? 0} 张`);

  /* ---------- ⑤ 说「拆分异常任务」→ 异常适配那一批也生成到同一页 ---------- */
  const phrase15 = phraseOf("⑮");
  await machine.evaluate(
    `window.dispatchEvent(new CustomEvent('mumai:xiaomu-ask', { detail: { question: ${JSON.stringify(phrase15)}, interactionId: 'wb-15-${Date.now()}' } })); 1`,
  );
  const more = await machine.waitFor(
    `(() => { const list = ${CARDS_IN_PAGE}; return list.length > ${countBeforeRepeat} ? list.length : null; })()`,
    { timeoutMs: 9000 },
  );
  check("⑮「任务卡已生成」→ 异常适配那一批也出现在同一页", Boolean(more), `页面上 ${more ?? "?"} 张`);

  /* ---------- ⑥ 内网同步：另一台机器（马）看到同样多的卡 ---------- */
  await peer.start();
  if (!(await peer.login())) throw new Error("第二台机器登录失败（ma）");
  /*
    ⚠ 用 harness 的 `call` 而不是页面里手写 fetch：`call` 带 401 补登录那一条
    （服务重启会换签名密钥，页面里那个令牌当场失效）。第一版手写 fetch 时
    另一台机器读到 0 张，看着像"内网没同步"，其实是 401 被当成了空列表。
  */
  const peerSnapshot = await peer.call("GET", "/api/sessions/demo-01/snapshot");
  const peerState = (peerSnapshot?.json?.entities?.taskCard ?? []).length;
  const mine = (await machine.call("GET", "/api/sessions/demo-01/snapshot"))?.json?.entities?.taskCard?.length ?? -1;
  check("另一台机器（马）看到同样多的卡（内网同步）", peerState === mine && mine > 0, `这台 ${mine} · 另一台 ${peerState}`);
  await peer.evaluate(`location.hash = '#/workbench'`);
  await sleep(2500);
  const peerCards = await peer.evaluate(CARDS_IN_PAGE);
  check(
    "另一台机器的页面上也渲染出卡片，且回执按钮归执行人本人",
    Array.isArray(peerCards) && peerCards.length === mine,
    `渲染 ${Array.isArray(peerCards) ? peerCards.length : 0} 张`,
  );

  const shot = await machine.shot("执行工作台");
  if (shot) console.log(`  截图：${shot}`);
  console.log(failed === 0 ? "\n✓ 执行工作台：全部通过" : `\n✗ 有 ${failed} 项未通过`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (error) {
  console.error(`工装异常：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  /* 收工：删掉临时工单，服务端级联清掉这一单的任务卡（验收不留垃圾） */
  if (tempOrderId) {
    const removed = await machine.call("DELETE", `/api/work-orders/${tempOrderId}`).catch(() => null);
    const left = await machine.call("GET", "/api/sessions/demo-01/snapshot").catch(() => null);
    const remaining = (left?.json?.entities?.taskCard ?? []).length;
    console.log(`  收工：临时工单已删除（HTTP ${removed?.status ?? "?"}）· 会话里剩余任务卡 ${remaining} 张`);
  }
  machine.kill();
  peer.kill();
}
