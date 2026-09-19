/**
 * 验收：数字孪生的**内部点云**（用户 2026-09-30 追加的一项）
 *
 * ── 这条工装回答的问题 ──────────────────────────────────────────────
 *   ① 数字孪生页上**有没有这一项**（主视图切换里那个「内部点云」页签）；
 *   ② 点进去**真的画出了点**（不是一块黑画布）—— 判据是渲染器自己报的
 *      `gl.info.render.points`（写在同一块 DOM 的 `data-points` 上），
 *      随便写个数字骗不过去：它是 WebGL 这一帧真正提交的点数；
 *   ③ 三类缺陷与**来源**都在屏上（虫蛀 / 内部裂痕 / 缺损，每条带编号或档案出处）；
 *   ④ 口径那行字在（"按外形与档案记录生成、不是实测点云"）；
 *   ⑤ 健康构件**没有被编缺陷**（Z01/Z02 显示"无内部缺陷记录"）。
 *
 * 用法（仓库根目录）：
 *   node --import ./tools/test-resolve-ts.mjs tools/验收-内部点云.mjs
 *   … --url http://127.0.0.1:5173      在内网 / dev 入口上再跑一遍
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

const machine = new Machine({ name: "ipc", port: 9577, base: BASE, account: "shi" });

try {
  console.log(`内部点云验收 · ${BASE}`);
  await machine.start();
  if (!(await machine.login())) throw new Error(`登录失败（shi）—— 页面在 ${BASE} 上吗？`);
  await machine.evaluate(`location.hash = '#/twin'`);
  await machine.waitFor(`Boolean(document.querySelector('.page--twin'))`, { timeoutMs: 12_000 });
  await sleep(800);

  /* ---------- ① 主视图里有没有这一项 ---------- */
  const tabs = await machine.waitFor(
    `(() => {
      const list = [...document.querySelectorAll('.twin-view__tab')].map((node) => (node.textContent || '').trim());
      return list.length ? list : null;
    })()`,
    { timeoutMs: 8000 },
  );
  check(
    `主视图切换里有「内部点云」这一项`,
    Array.isArray(tabs) && tabs.some((text) => text.includes("内部点云")),
    (tabs ?? []).join(" / "),
  );

  /* ---------- ② 点进去，等渲染器报点数 ---------- */
  const clicked = await machine.evaluate(`(() => {
    const tab = [...document.querySelectorAll('.twin-view__tab')].find((node) => (node.textContent || '').includes('内部点云'));
    if (!tab) return false;
    tab.click();
    return true;
  })()`);
  check("点得动", clicked === true);

  const drawn = await machine.waitFor(
    `(() => {
      const stage = document.querySelector('.ipc__stage');
      if (!stage) return null;
      const points = Number(stage.getAttribute('data-points') || 0);
      const canvas = stage.querySelector('canvas');
      return points > 0 && canvas && canvas.width > 100 ? { points, width: canvas.width, height: canvas.height } : null;
    })()`,
    { timeoutMs: 25_000 },
  );
  check(
    `画布真的画出了点（渲染器自报点数）`,
    Boolean(drawn && drawn.points > 10_000),
    drawn ? `${drawn.points} 个点 · 画布 ${drawn.width}×${drawn.height}` : "25 秒内没等到点数（WebGL 没画出来？）",
  );

  /* ---------- ③ 三类缺陷与来源 ---------- */
  const text = await machine.evaluate(`document.body.innerText || ''`);
  check("三类缺陷的名字都在（虫蛀 / 内部裂痕 / 缺损）", ["虫蛀空洞", "内部裂痕", "缺损"].every((key) => text.includes(key)));
  check(
    "每一处缺陷都带着出处（风险记录编号或档案原话）",
    /CUR-Z04-0\d/.test(text) && /档案[：:]/.test(text),
    /CUR-Z04-0\d/.test(text) ? "含风险记录编号" : "没看到风险记录编号",
  );
  check("四根柱子的外形（柱径/材种）在屏上", /直径\s*\d{3}\s*mm/.test(text) && /(楠木|杉木)/.test(text));

  /* ---------- ④ 口径那行字 ---------- */
  check(
    `写明「按外形与档案记录生成、不是实测点云」`,
    /按构件外形与档案记录生成/.test(text) && /不是实测点云/.test(text) && /预置结果/.test(text),
  );

  /* ---------- ⑤ 健康构件没有被编缺陷 ---------- */
  const healthy = await machine.evaluate(`(() => {
    const list = [...document.querySelectorAll('.ipc__specs li')].map((node) => (node.textContent || '').replace(/\\s+/g, ' ').trim());
    return list;
  })()`);
  const z01 = (healthy ?? []).find((row) => row.startsWith("Z01")) ?? "";
  const z02 = (healthy ?? []).find((row) => row.startsWith("Z02")) ?? "";
  check(`Z01（档案：外观连续）显示「无内部缺陷记录」`, z01.includes("无内部缺陷记录"), z01 || "没找到 Z01 那行");
  check(`Z02（档案：轻微褪色）显示「无内部缺陷记录」`, z02.includes("无内部缺陷记录"), z02 || "没找到 Z02 那行");

  /* ---------- ⑥ 「只看选中构件」与 ㉒ 的自动切换 ---------- */
  const solo = await machine.evaluate(`(() => {
    const button = [...document.querySelectorAll('.ipc__toggle')].find((node) => (node.textContent || '').includes('只看 Z04'));
    if (!button) return null;
    button.click();
    return (button.textContent || '').trim();
  })()`);
  check(`有「只看 Z04」这一项且点得动`, Boolean(solo), solo ?? "没找到那个开关");
  const soloState = await machine.waitFor(
    `(() => {
      const specs = [...document.querySelectorAll('.ipc__specs li')].map((node) => node.textContent || '');
      return specs.length === 1 && specs[0].includes('Z04') ? { count: specs.length } : null;
    })()`,
    { timeoutMs: 8000 },
  );
  check(`勾上之后只剩选中的那一根`, Boolean(soloState), soloState ? `剩 ${soloState.count} 根` : "还是四根都在");

  /*
    ㉒「证据对照」播完时 `executor` 派发的事件 —— 这里**直接派发同一条事件**验证接线，
    不重跑那一轮的播报（省时间，且这一条要证的正是"事件到页面的那段线"）。
  */
  await machine.evaluate(`location.hash = '#/twin?component=Z04'`);
  await machine.waitFor(`Boolean(document.querySelector('.page--twin'))`, { timeoutMs: 10_000 });
  await sleep(600);
  const opened = await machine.evaluate(`(() => {
    window.dispatchEvent(new CustomEvent('mumai:twin-internal-cloud', { detail: { componentId: 'Z04' } }));
    return true;
  })()`);
  const autoView = await machine.waitFor(
    `(() => {
      const active = document.querySelector('.twin-view__tab.is-active');
      const stage = document.querySelector('.ipc__stage');
      return active && stage && (active.textContent || '').includes('内部点云')
        ? { tab: (active.textContent || '').trim(), points: Number(stage.getAttribute('data-points') || 0) }
        : null;
    })()`,
    { timeoutMs: 20_000 },
  );
  check(
    `㉒ 的事件能把主视图切到内部点云（并画出点）`,
    opened === true && Boolean(autoView && autoView.points > 10_000),
    autoView ? `${autoView.tab} · ${autoView.points} 个点` : "20 秒内没切过去",
  );

  const shot = await machine.shot("内部点云");
  if (shot) console.log(`  截图：${shot}`);
  console.log(failed === 0 ? "\n✓ 内部点云：全部通过" : `\n✗ 有 ${failed} 项未通过`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (error) {
  console.error(`工装异常：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  machine.kill();
}
