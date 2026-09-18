/**
 * 验收：**环境读数的录入预备数据**（弹窗里按 Enter 依次填入的那一组）
 *
 * 用户口径（2026-09-23）：「把录入读数预备数据改成当前温度22摄氏度，相对湿度58%，
 * 风速0.6米每秒，大气压强101千帕」——即剧本《木脉智检.docx》第 71 行沈的口播。
 *
 * 这条工装按**现场那条路**走一遍，不看代码只看屏幕：
 *   ① 在工单页点开「录入读数」弹窗，焦点落在第一个输入框；
 *   ② 连按 6 次 Enter（提词器一步一项）；
 *   ③ 断言输入框里逐字是 22 / 58 / 0.6 / 101，气压单位自动拨到 **kPa**，
 *      位置与测量时间也填上了；
 *   ④ 保存草稿 → 运行校验：**101 kPa（= 1010 hPa）必须过得了服务端的量程判据**，
 *      并在页面上生成配置版本（不过就说明这组数现场按 Enter 会当场判红）。
 *
 * 全程跑在**临时工单**上，收工把工单删掉（级联清环境草稿与配置版本），不给演示库留东西。
 *
 * 用法（仓库根目录）：
 *   node --import ./tools/test-resolve-ts.mjs tools/验收-环境读数预设.mjs
 *   … --url http://192.168.1.5:8000
 */

import { Machine, sleep } from "./browser-harness.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf("url", process.env.MUMAI_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const ACCOUNT = argOf("account", "shi");

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `　（${detail}）` : ""}`);
  if (!ok) failed += 1;
};

const machine = new Machine({ name: "envpreset", port: 9571, base: BASE, account: ACCOUNT });
let tempOrderId = null;

/** 读弹窗里六项的值 + 气压单位 */
const READ_MODAL = `(() => {
  const modal = document.querySelector('.modal, [role="dialog"]');
  if (!modal) return null;
  const inputs = [...modal.querySelectorAll('input')];
  const unit = modal.querySelector('select');
  return {
    values: inputs.map((node) => node.value),
    unit: unit ? unit.value : null,
  };
})()`;

try {
  console.log(`环境读数预设验收 · ${BASE} · 账号 ${ACCOUNT}`);
  await machine.start();
  if (!(await machine.login())) throw new Error(`登录失败（${ACCOUNT}）`);
  console.log("  已登录\n");

  /* 临时工单：这一组读数按单录入，验收不该写进演示库里那张单 */
  const created = await machine.call("POST", "/api/work-orders/trigger", { eventId: `env-preset-${Date.now().toString(36)}` });
  if (created?.status !== 200 || !created.json?.orderId) throw new Error(`建临时工单失败：${JSON.stringify(created?.json)}`);
  tempOrderId = created.json.orderId;
  console.log(`  临时工单 ${created.json.orderNo}（${tempOrderId}）\n`);

  /* ① 打开工单页与环境录入弹窗 */
  await machine.evaluate(`location.hash = '#/orders?order=${tempOrderId}'`);
  await sleep(3000);
  const opened = await machine.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) => (node.textContent || '').trim() === '录入读数');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  check("工单页上「录入读数」可点（shi 有环境录入权限）", opened === true);
  await machine.waitFor(`Boolean(document.querySelector('.modal, [role="dialog"]'))`, { timeoutMs: 6000 });
  const empty = await machine.evaluate(READ_MODAL);
  check("弹窗打开时六项是空的（预设不是默认值）", Boolean(empty) && empty.values.every((value) => value === ""), JSON.stringify(empty?.values));

  /* ② 连按 6 次 Enter（一次一项） */
  for (let i = 0; i < 6; i += 1) {
    await machine.evaluate(`(() => {
      const modal = document.querySelector('.modal, [role="dialog"]');
      const input = modal && modal.querySelector('input');
      if (!input) return false;
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      return true;
    })()`);
    await sleep(220);
  }
  const filled = await machine.evaluate(READ_MODAL);
  const [airTempC, humidity, wind, pressure] = filled?.values ?? [];
  check("温度填成 22", airTempC === "22", `实际 ${JSON.stringify(airTempC)}`);
  check("相对湿度填成 58", humidity === "58", `实际 ${JSON.stringify(humidity)}`);
  check("风速填成 0.6", wind === "0.6", `实际 ${JSON.stringify(wind)}`);
  check("大气压填成 101", pressure === "101", `实际 ${JSON.stringify(pressure)}`);
  check("气压单位自动拨到 kPa（剧本念的是「101千帕」）", filled?.unit === "kPa", `实际 ${JSON.stringify(filled?.unit)}`);
  check(
    "测量位置与测量时间也填上了（后两项）",
    Boolean(filled?.values?.[4]) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(filled?.values?.[5])),
    `位置=${JSON.stringify(filled?.values?.[4])} 时间=${JSON.stringify(filled?.values?.[5])}`,
  );
  const shot = await machine.shot("环境读数预设-弹窗");
  if (shot) console.log(`  截图：${shot}`);

  /* ③ 保存草稿 */
  const saved = await machine.evaluate(`(() => {
    const button = [...document.querySelectorAll('.modal button, [role="dialog"] button')].find((node) => (node.textContent || '').includes('保存草稿'));
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  check("「保存草稿」可点并已提交", saved === true);
  await sleep(2500);
  const detail = (await machine.call("GET", `/api/work-orders/${tempOrderId}`))?.json ?? null;
  check(
    "服务端落库的四项读数与屏幕一致（101 kPa 换算成 1010 hPa）",
    detail?.environment?.inputs?.airTempC === 22 &&
      detail?.environment?.inputs?.relativeHumidityPct === 58 &&
      detail?.environment?.inputs?.windSpeedMs === 0.6 &&
      detail?.environment?.inputs?.atmosphericPressureHpa === 1010,
    `服务端读到 温度${detail?.environment?.inputs?.airTempC} 湿度${detail?.environment?.inputs?.relativeHumidityPct} 风速${detail?.environment?.inputs?.windSpeedMs} 气压${detail?.environment?.inputs?.atmosphericPressureHpa} hPa`,
  );

  /* ④ 运行校验：1010 hPa 必须过量程判据 */
  /*
    ⚠ 服务端有一条硬前置：**工单没指派过，环境校验一律拒**（NOT_ASSIGNED）——
    临时工单是刚建的、没有任何负责人，所以这里先按平台自己的候选清单指派一次
    （四个角色各取第一位候选人 + 该角色建议职责），再跑校验。
    第一版没做这一步，校验一直生成不出配置版本，看着像"读数不合格"，其实是前置没满足。
  */
  const beforeAssign = (await machine.call("GET", `/api/work-orders/${tempOrderId}`))?.json ?? null;
  const groups = beforeAssign?.accounts ?? [];
  if (groups.length >= 2) {
    const leaderGroup = groups[0];
    const assigned = await machine.call("PUT", `/api/work-orders/${tempOrderId}/assignment`, {
      leaderAccountId: leaderGroup.candidates?.[0]?.accountId,
      members: groups.slice(1).map((group) => ({
        accountId: group.candidates?.[0]?.accountId,
        duties: (group.suggestedDuties ?? []).map((duty) => duty.code),
      })),
      expectedRevision: beforeAssign?.order?.assignmentRevision ?? 0,
    });
    check("临时工单先按平台候选清单指派（校验的硬前置）", assigned?.status === 200, `HTTP ${assigned?.status}`);
  } else {
    check("临时工单先按平台候选清单指派（校验的硬前置）", false, "接口没给候选分组，无法指派");
  }

  const validated = await machine.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) => (node.textContent || '').trim() === '运行校验');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  check("「运行校验」可点", validated === true);
  const configVersion = await machine.waitFor(
    `(async () => {
      const response = await fetch('/api/work-orders/${tempOrderId}', { headers: { authorization: 'Bearer ' + (localStorage.getItem('mumai.token') || '') } });
      const body = await response.json();
      return body && body.environment && body.environment.config ? body.environment.config.configVersion : null;
    })()`,
    { timeoutMs: 12_000 },
  );
  check("校验通过并生成配置版本（101 kPa = 1010 hPa 落在 300–1100 量程内）", Boolean(configVersion), `配置版本 ${configVersion ?? "—"}`);

  console.log(failed === 0 ? "\n✓ 环境读数预设：全部通过" : `\n✗ 有 ${failed} 项未通过`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (error) {
  console.error(`工装异常：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  /* 收工：删掉临时工单（级联清环境草稿与配置版本） */
  if (tempOrderId) {
    const removed = await machine.call("DELETE", `/api/work-orders/${tempOrderId}`).catch(() => null);
    console.log(`  收工：临时工单已删除（HTTP ${removed?.status ?? "?"}）`);
  }
  machine.kill();
}
