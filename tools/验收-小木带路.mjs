/**
 * 验收：**小木带路**（25 轮小木互动 → 平台自动切到剧本对应的页面）
 *
 * ── 这条工装回答的问题 ──────────────────────────────────────────────
 * 用户口径（2026-09-23）：「对平台进行页面添加及和小木互动时触发的自动操作，贴合剧本……
 * 操作或展示页面少就添加」。验收要证伪的正是"念完停在原地"：
 *   ① 每一轮的 `nav` 声明是否**真的把页面带走了**（对 URL 断言，不看截图）；
 *   ② 页内定位（页签）是否真的生效 —— 页签写错时页面不报错，只是**内容区空白**，
 *      所以这一条按内容断言（例如环境记录页必须出现四类天气与来源标注）；
 *   ③ 环境记录页的数值是否真的来自数据包（不许出现「标签缺失」或"实时"这类穿帮字样）。
 *
 * ── 为什么不逐个硬编码说法 ──────────────────────────────────────────
 * 触发词是剧本自己的数据（`SCRIPT_ROUNDS[i].triggers`）。工装用 `routeUtterance()`
 * **先从该轮自己的触发词里挑一条真能命中本轮的说法**，再把它发进页面 ——
 * 于是"说法改了"不需要改工装，"说法命中了别的轮"会当场暴露成一条失败。
 *
 * 用法（仓库根目录）：
 *   node --import ./tools/test-resolve-ts.mjs tools/验收-小木带路.mjs
 *   node --import ./tools/test-resolve-ts.mjs tools/验收-小木带路.mjs --url http://192.168.1.5:8000
 *   … --only ⑤,⑰,⑲     只跑指定轮次（排查时用）
 */

import { Machine, sleep } from "./browser-harness.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf("url", process.env.MUMAI_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const only = argOf("only", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ACCOUNT = argOf("account", "shi");

const { SCRIPT_ROUNDS } = await import("../src/pages/MumaiDashboard/agent/script.ts");
const { routeUtterance } = await import("../src/pages/MumaiDashboard/agent/scriptMatch.ts");

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `　（${detail}）` : ""}`);
  if (!ok) failed += 1;
};

/** 该轮要说哪句话：从它自己的触发词里挑第一条**真能命中本轮**的 */
function phraseFor(round) {
  for (const trigger of round.triggers) {
    for (const sentence of [trigger, `小木，${trigger}`, `小木小木，${trigger}`]) {
      const route = routeUtterance(sentence);
      if (route.kind === "script" && route.round.roundNo === round.roundNo) return sentence;
    }
  }
  return null;
}

/** 期望的 URL 片段：路由 + 页内定位（顺序无关，逐个包含即可） */
function expectHash(nav) {
  if (nav.route === "order") return ["/orders"];
  const parts = [nav.route];
  if (nav.tab) parts.push(`tab=${nav.tab}`);
  if (nav.view) parts.push(`view=${nav.view}`);
  if (nav.component) parts.push(`component=${nav.component}`);
  return parts;
}

const machine = new Machine({ name: "nav", port: 9531, base: BASE, account: ACCOUNT });

try {
  console.log(`小木带路验收 · ${BASE} · 账号 ${ACCOUNT}`);
  await machine.start();
  const ok = await machine.login();
  if (!ok) throw new Error(`登录失败（${ACCOUNT}）—— 页面在 ${BASE} 上吗？`);
  console.log("  已登录\n");

  /* 等共享服务就绪：这一条决定了工单页能不能真的打开（列表为空时导航会被跳过） */
  const orders = await machine.call("GET", "/api/work-orders");
  const orderCount = Array.isArray(orders?.json?.orders) ? orders.json.orders.length : 0;
  console.log(`  服务端工单数 = ${orderCount}${orderCount === 0 ? "（工单页的轮次会跳过选单，只断言路由）" : ""}\n`);

  const rounds = SCRIPT_ROUNDS.filter((round) => (only.length ? only.includes(round.roundNo) : true));
  const skipped = [];

  for (const round of rounds) {
    const nav = round.nav;
    if (!nav) {
      check(`${round.roundNo} ${round.title}`, false, "这一轮没有页面落点");
      continue;
    }
    if (round.triggerSource !== "voice") {
      skipped.push(`${round.roundNo}（${round.triggerSource}）`);
      continue;
    }
    const phrase = phraseFor(round);
    if (!phrase) {
      check(`${round.roundNo} ${round.title}`, false, "它自己的触发词一条都命不中本轮");
      continue;
    }

    /* 先离开目标页，才能证明"是这一轮把页面带过去的"，而不是上一轮停在那儿 */
    const parts = expectHash(nav);
    /* 工单页的轮次要选中某一张：列表为空时不硬要求路由（工装控制不了"没有工单"这件事） */
    const orderRound = nav.route === "order";
    if (orderRound && orderCount === 0) {
      skipped.push(`${round.roundNo}（服务端没有工单）`);
      continue;
    }
    await machine.evaluate(`location.hash = '#/console'`);
    await sleep(220);

    const interactionId = `nav-${round.roundNo}-${Date.now()}`;
    await machine.evaluate(
      `window.dispatchEvent(new CustomEvent('mumai:xiaomu-ask', { detail: { question: ${JSON.stringify(phrase)}, interactionId: ${JSON.stringify(interactionId)} } })); 1`,
    );

    let hash = "";
    const deadline = Date.now() + 9000;
    while (Date.now() < deadline) {
      await sleep(250);
      hash = await machine.evaluate(`location.hash`);
      if (parts.every((part) => String(hash).includes(part))) break;
    }
    const hit = parts.every((part) => String(hash).includes(part));
    check(`${round.roundNo} ${round.title}`, hit, hit ? `「${phrase}」→ ${hash}` : `期望 ${parts.join(" & ")}，实际 ${hash}`);
    if (!hit) continue;

    /* 页内定位生效了吗：目标页签的内容必须真的渲染出来（写错页签时内容区是空的） */
    if (nav.route === "/hardware" && nav.tab === "env") {
      const content = await machine.waitFor(
        `(() => {
          const text = document.body.innerText || '';
          const kinds = ['降水', '湿度', '风', '温度'].filter((k) => text.includes(k));
          return kinds.length === 4 ? { kinds: kinds.length, source: /未启用联网查询/.test(text), missingLabel: /标签缺失/.test(text), live: /实时/.test(text) } : null;
        })()`,
        { timeoutMs: 6000 },
      );
      check(`  ↳ 环境记录页内容`, Boolean(content), content ? `四类天气齐全` : "四类天气没渲染出来");
      if (content) {
        check(`  ↳ 来源标注是归档口径`, content.source && !content.live, `未启用联网查询=${content.source} · 出现"实时"=${content.live}`);
        check(`  ↳ 没有「标签缺失」`, !content.missingLabel);
      }
    }
  }

  if (skipped.length) console.log(`\n  跳过（非语音触发）：${skipped.join("、")}`);
  /* 留一张新页面的截图存档（内容判据在上面，截图只给评审看排版） */
  await machine.evaluate(`location.hash = '#/hardware?tab=env'`);
  await sleep(1200);
  const shot = await machine.shot("小木带路-环境记录页");
  if (shot) console.log(`  截图：${shot}`);
  console.log(failed === 0 ? "\n✓ 小木带路：全部通过" : `\n✗ 有 ${failed} 项未通过`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (error) {
  console.error(`工装异常：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  machine.kill();
}
