/**
 * 验收：工单识别（剧本 §9「史点击工单识别」+ 内网同步）
 *
 * ── 这条工装回答的问题 ──────────────────────────────────────────────
 * 用户文档 §9 的动作列写的是**史在平台上点一下**：
 *   （史点击工单识别；小木读取当前工单与附件索引，生成任务卡和装备核对清单，
 *     未填字段标为待补。）
 * 于是要证伪的是四件事：
 *   ① 工单页上真有这个按钮，而且史点得动（不是置灰的摆设）；
 *   ② 点下去**真的是第②轮**在演（台词对得上，不是隔壁那一轮）；
 *   ③ 读的是**屏幕上这一张单**：故意建两张临时工单、停在**较旧**那张上点它 ——
 *      单据一旦被"列表最新"顶掉，这里就会红（这正是防幻觉规则 3 的判据）；
 *   ④ 工单页跟着播报**逐组展开**，并且这台机器上发生的事在**另一台机器**上同步
 *      （同一句话、同一张工单，跟随端不出声）。
 *
 * 用法（仓库根目录）：
 *   node --import ./tools/test-resolve-ts.mjs tools/验收-工单识别.mjs
 *   … --url http://192.168.1.5:8000        在内网地址上跑（两块屏走同一地址）
 *
 * 收工：两张临时工单都会删掉（服务端级联清掉挂在它们下面的任务卡）。
 */

import { Machine, sleep } from "./browser-harness.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf("url", process.env.MUMAI_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");

/** 第②轮主台词里那句独一无二的话（用来判"演的是不是这一轮"） */
const ROUND2_TEXT = "已整理为四项任务";
/** 按钮与页面上的口径（与 `pages/orders/orderRecognize.ts` 一致） */
const BUTTON_LABEL = "工单识别";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `　（${detail}）` : ""}`);
  if (!ok) failed += 1;
};

const A = new Machine({ name: "rec-a", port: 9563, base: BASE, account: "shi" });
/** 第二台机器：项目经理的电脑（跟随讲解机） */
const B_ACCOUNT = "shen";
const B = new Machine({ name: "rec-b", port: 9564, base: BASE, account: B_ACCOUNT });

/** 点按钮后要看的三个量：按钮点得动吗、揭示展开了几组、气泡里是哪一句 */
const READ_PAGE = `(() => {
  const button = [...document.querySelectorAll('button')].find((node) => (node.textContent || '').trim() === ${JSON.stringify(BUTTON_LABEL)});
  const reveal = [...document.querySelectorAll('.wop-reveal')];
  return {
    hasButton: Boolean(button),
    disabled: button ? Boolean(button.disabled) : null,
    revealTotal: reveal.length,
    revealed: reveal.filter((node) => node.classList.contains('is-in')).length,
    body: document.body.innerText || '',
  };
})()`;

const tempOrderIds = [];

const makeOrder = async (machine) => {
  const created = await machine.call("POST", "/api/work-orders/trigger", {
    eventId: `e2e-recognize-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
  });
  if (created?.status !== 200 || !created.json?.orderId) {
    throw new Error(`建临时工单失败：${JSON.stringify(created?.json)}`);
  }
  tempOrderIds.push(created.json.orderId);
  return { id: created.json.orderId, orderNo: created.json.orderNo };
};

try {
  console.log(`工单识别验收 · ${BASE}`);
  await A.start();
  await B.start();
  if (!(await A.login())) throw new Error(`登录失败（shi）—— 页面在 ${BASE} 上吗？`);
  if (!(await B.login())) throw new Error(`登录失败（${B_ACCOUNT}）`);
  await sleep(1200);
  console.log("  两台已登录（shi / shen）\n");

  /* B 上装"有没有出过声"的计数器：跟随只跟随画面与文字，**不该**出声 */
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

  /*
    两张临时工单：**先建的那张（older）是我们要点的那张**，后建的是"列表最新"。
    这样"按钮读的是屏幕上这一张"才是一个可证伪的判据 —— 只建一张时，
    "列表最新"与"当前这张"恰好是同一张，写错了也看不出来。
  */
  const older = await makeOrder(A);
  await sleep(300);
  const newer = await makeOrder(A);
  console.log(`  临时工单：要点的是 ${older.orderNo}（较旧）· 列表最新是 ${newer.orderNo}\n`);

  /* ---------- ① 打开较旧那张单，按钮在、且点得动 ---------- */
  await A.evaluate(`location.hash = '#/orders?order=${older.id}'`);
  const ready = await A.waitFor(
    `(() => { const state = ${READ_PAGE}; return state.hasButton ? state : null; })()`,
    { timeoutMs: 15_000 },
  );
  check(`工单页上有「${BUTTON_LABEL}」按钮`, Boolean(ready?.hasButton), ready ? "" : "页面上没找到这个按钮");
  check(
    "史（全量权限）点得动它 —— 不是置灰的摆设",
    ready?.disabled === false,
    `disabled=${ready?.disabled}`,
  );

  /* ---------- ② 点它：第②轮开演，且读的是屏幕上这一张单 ---------- */
  const clicked = await A.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) => (node.textContent || '').trim() === ${JSON.stringify(BUTTON_LABEL)});
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  check("点得下去（浏览器真的收到了这次点击）", clicked === true);
  /* 点完立刻取一次：揭示**不该**已经是全展开的（那说明整页一次性铺开了） */
  await sleep(300);
  const early = await A.evaluate(READ_PAGE);
  check(
    "点下的瞬间工单页**还没**整页铺开（是跟着台词逐组展开的）",
    Number(early?.revealed ?? 0) < Number(early?.revealTotal ?? 0),
    `已展开 ${early?.revealed}/${early?.revealTotal}`,
  );

  const lineOnA = await A.waitFor(
    `(() => ((document.body.innerText || '').includes(${JSON.stringify(ROUND2_TEXT)}) ? ${JSON.stringify(ROUND2_TEXT)} : null))()`,
    { timeoutMs: 20_000 },
  );
  check("点一下 = 小木念第②轮的台词", Boolean(lineOnA), lineOnA ?? "20 秒内没看到这句");

  const hashA = String(await A.evaluate(`location.hash`));
  check(
    `读的是屏幕上这一张（${older.orderNo}），没有被"列表最新"顶掉`,
    hashA.includes(older.id) && !hashA.includes(newer.id),
    `hash=${hashA}`,
  );

  /* ---------- ③ 逐组展开跑完：该显示的都显示出来 ---------- */
  const expanded = await A.waitFor(
    `(() => { const state = ${READ_PAGE}; return state.revealed >= state.revealTotal && state.revealTotal > 1 ? state : null; })()`,
    { timeoutMs: 30_000 },
  );
  check(
    "播报期间四组模块逐组展开、最后全部可见",
    Boolean(expanded),
    expanded ? `${expanded.revealed}/${expanded.revealTotal} 组` : "30 秒内没等到全部展开",
  );

  /* ---------- ④ 内网同步：另一台机器同一句话、同一张工单 ---------- */
  const lineOnB = await B.waitFor(
    `(() => ((document.body.innerText || '').includes(${JSON.stringify(ROUND2_TEXT)}) ? ${JSON.stringify(ROUND2_TEXT)} : null))()`,
    { timeoutMs: 20_000 },
  );
  check("另一台机器（项目经理）显示**同一句台词**", Boolean(lineOnB), lineOnB ?? "B 上没有出现这句");
  const hashB = String(await B.evaluate(`location.hash`));
  check(
    "另一台机器跟到**同一张工单**（带上发起端解析好的工单 id）",
    hashB.includes(older.id),
    `B hash=${hashB}`,
  );
  /* 跟随端不出声：多台机器同时放音会互相打架 */
  const spoken = await B.evaluate(`window.__spoken`);
  check(
    "跟随端不出声",
    Number(spoken?.synth ?? -1) === 0 && Number(spoken?.audio ?? -1) === 0,
    `语音合成 ${spoken?.synth} 次 · 音频对象 ${spoken?.audio} 个`,
  );

  const shot = await A.shot("工单识别");
  if (shot) console.log(`  截图：${shot}`);
  console.log(failed === 0 ? "\n✓ 工单识别：全部通过" : `\n✗ 有 ${failed} 项未通过`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (error) {
  console.error(`工装异常：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  /* 收工：两张临时工单都删掉（级联清任务卡），不给演示库留垃圾 */
  for (const id of tempOrderIds) {
    const removed = await A.call("DELETE", `/api/work-orders/${id}`).catch(() => null);
    console.log(`  收工：临时工单 ${id} 已删除（HTTP ${removed?.status ?? "?"}）`);
  }
  A.kill();
  B.kill();
}
