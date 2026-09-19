/**
 * 验收：平台能**把工单归档**（用户 2026-10-01：「平台得能把工单归档」）
 *
 * ── 为什么要有这条 ──────────────────────────────────────────────────
 * 演示库里那张工单一直是「待指派」（现场没人点"指派"），而改之前归档只允许
 * 待准备/待作业/作业中/待验收 —— 讲解人想收档时**按钮根本不出现**，
 * 能力位与迁移表两处名单还不一致（暂停中的单子界面给按钮、服务端回 422）。
 *
 * 这条工装在一张**临时工单**上真点一遍（不动演示库那张）：
 *   ① 待指派状态下能看到「归档」按钮；
 *   ② 点它先弹确认（终态动作必须再问一次），确认文案写清后果；
 *   ③ 确认后状态变「已归档」，正文里不再有可点的状态动作；
 *   ④ 工单列表的「已归档」筛选里查得到它；
 *   ⑤ 服务端留痕：操作日志里有"归档"。
 * 收工把临时工单删掉（演示库不留垃圾）。
 *
 * 用法（仓库根目录）：
 *   node --import ./tools/test-resolve-ts.mjs tools/验收-工单归档.mjs
 *   … --url http://192.168.31.202:8000      在内网地址上再跑一遍
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

const machine = new Machine({ name: "archive", port: 9607, base: BASE, account: "shi" });
let tempOrderId = null;

try {
  console.log(`工单归档验收 · ${BASE}`);
  await machine.start();
  if (!(await machine.login())) throw new Error(`登录失败（shi）—— 页面在 ${BASE} 上吗？`);

  /* 临时工单：新建出来就是「待指派」，正是演示库那张单的状态 */
  const created = await machine.call("POST", "/api/work-orders/trigger", {
    eventId: `e2e-archive-${Date.now().toString(36)}`,
  });
  if (created?.status !== 200 || !created.json?.orderId) throw new Error(`建临时工单失败：${JSON.stringify(created?.json)}`);
  tempOrderId = created.json.orderId;
  const orderNo = created.json.orderNo;
  console.log(`  临时工单 ${orderNo} · 状态 ${created.json.status}\n`);

  /* ---------- ① 待指派状态下就有「归档」按钮 ---------- */
  await machine.evaluate(`location.hash = '#/orders?order=${tempOrderId}'`);
  await machine.waitFor(`Boolean(document.querySelector('.wop-actions'))`, { timeoutMs: 15_000 });
  await sleep(800);
  const button = await machine.waitFor(
    `(() => {
      const node = [...document.querySelectorAll('.wop-actions button')].find((item) => (item.textContent || '').trim() === '归档');
      return node ? { text: (node.textContent || '').trim(), disabled: node.disabled } : null;
    })()`,
    { timeoutMs: 12_000 },
  );
  check(
    `待指派的工单上就有「归档」按钮（改之前按钮根本不出现）`,
    Boolean(button && button.disabled === false),
    button ? `按钮「${button.text}」disabled=${button.disabled}` : "12 秒内没找到「归档」按钮",
  );
  if (!button) throw new Error("没有归档按钮，后面的判据没有意义");

  /* ---------- ② 点它先弹确认（终态动作必须再问一次） ---------- */
  const modal = await machine.waitFor(
    `(() => {
      const button = [...document.querySelectorAll('.wop-actions button')].find((item) => (item.textContent || '').trim() === '归档');
      if (!button) return null;
      button.click();
      const box = document.querySelector('.modal, .dsf, [role="dialog"]');
      if (!box) return null;
      const confirm = [...box.querySelectorAll('button')].find((item) => (item.textContent || '').includes('确认归档'));
      const text = (box.textContent || '').replace(/\\s+/g, ' ').trim();
      return confirm ? { confirm: (confirm.textContent || '').trim(), text } : null;
    })()`,
    { timeoutMs: 8000 },
  );
  check(
    `点「归档」先弹确认框，且确认按钮是「确认归档」`,
    Boolean(modal),
    modal ? `确认按钮=「${modal.confirm}」` : "没有弹出确认框（点一下就归档了？）",
  );
  check(
    `确认文案写清后果（终态 / 已归档筛选 / 不能再改）`,
    Boolean(modal && /终态|已归档/.test(modal.text) && /不能再改|不能再改指派/.test(modal.text)),
    modal ? modal.text.slice(0, 90) : "没有取到文案",
  );

  /* ---------- ③ 确认后状态变「已归档」 ---------- */
  const confirmed = await machine.evaluate(`(() => {
    const box = document.querySelector('.modal, .dsf, [role="dialog"]');
    if (!box) return false;
    const confirm = [...box.querySelectorAll('button')].find((item) => (item.textContent || '').includes('确认归档'));
    if (!confirm) return false;
    confirm.click();
    return true;
  })()`);
  const archived = await machine.waitFor(
    `(() => {
      const text = document.body.innerText || '';
      if (!text.includes('已归档')) return null;
      const actions = [...document.querySelectorAll('.wop-actions button')].map((item) => (item.textContent || '').trim());
      /* 归档后状态动作应当全部消失（只剩「工单识别」与「删除工单」这类非状态动作） */
      const stateActions = actions.filter((label) => ['开始作业', '提交验收', '验收通过并归档', '暂停', '恢复', '归档'].includes(label));
      return stateActions.length === 0 ? { actions } : null;
    })()`,
    { timeoutMs: 12_000 },
  );
  check(
    `确认后状态变「已归档」，状态动作全部收起`,
    confirmed === true && Boolean(archived),
    archived ? `剩余按钮：${archived.actions.join(' / ') || '（无）'}` : "12 秒内没等到已归档",
  );

  /* ---------- ④ 列表的「已归档」筛选里查得到 ---------- */
  const listed = await machine.evaluate(`(async () => {
    const token = localStorage.getItem('mumai.token') || '';
    const response = await fetch('/api/work-orders?filter=archived', { headers: { authorization: 'Bearer ' + token } });
    const body = await response.json();
    const rows = body.orders || body || [];
    return rows.some((item) => item.id === ${JSON.stringify(tempOrderId)});
  })()`);
  check(`工单列表的「已归档」筛选里能查到这张单`, listed === true);

  /* ---------- ⑤ 服务端留痕 ---------- */
  /*
    ⚠ 操作日志在工单详情里（服务端 SQLite 的 work_order_logs），**不是**会话快照里的实体 ——
    第一版去快照里找 `orderLog`，拿到 0 条，看着像"没留痕"（假红）。
  */
  const detail = await machine.call("GET", `/api/work-orders/${tempOrderId}`);
  const logs = detail?.json?.logs ?? [];
  check(
    `服务端有归档记录（工单详情的操作日志留痕）`,
    logs.some((item) => String(item.type ?? "").includes("归档") || String(item.text ?? "").includes("归档")),
    `日志 ${logs.length} 条 · ${logs.slice(-1).map((item) => `${item.type}/${item.text}`).join("") || "（空）"}`,
  );

  const shot = await machine.shot("工单归档");
  if (shot) console.log(`  截图：${shot}`);
  console.log(failed === 0 ? "\n✓ 工单归档：全部通过" : `\n✗ 有 ${failed} 项未通过`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (error) {
  console.error(`工装异常：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  if (tempOrderId) {
    const removed = await machine.call("DELETE", `/api/work-orders/${tempOrderId}`).catch(() => null);
    console.log(`  收工：临时工单已删除（HTTP ${removed?.status ?? "?"}）`);
  }
  machine.kill();
}
