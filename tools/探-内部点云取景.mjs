/**
 * 探针：内部点云「只看一根」时的**取景**对不对（人工看图用，不是验收）
 *
 * 为什么要单独跑一遍：柱子是点云，画没画只能靠渲染器报点数（验收工装管这个），
 * 但"画在画面哪儿、占多大"只能看截图。第一版按整个场景（±3.2 m）取景，
 * 单看 Z04 时柱子只在画面中间一小条 —— 这个探针就是拍这一张图。
 *
 * 用法（仓库根目录）：
 *   node --import ./tools/test-resolve-ts.mjs tools/探-内部点云取景.mjs
 */

import { Machine, sleep } from "./browser-harness.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argOf("url", process.env.MUMAI_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");

const machine = new Machine({ name: "ipc-view", port: 9579, base: BASE, account: "shi" });

/** 等渲染器报出点数，歇一下（点数按 0.5 s 一帧上报，切完立刻读会读到上一个状态的值），再截图 */
const shotWhenDrawn = async (name, timeoutMs = 25_000) => {
  await machine.waitFor(
    `(() => {
      const stage = document.querySelector('.ipc__stage');
      return stage && Number(stage.getAttribute('data-points') || 0) > 10_000 ? true : null;
    })()`,
    { timeoutMs },
  );
  await sleep(1400);
  const drawn = await machine.evaluate(`(() => {
    const stage = document.querySelector('.ipc__stage');
    return stage
      ? { points: Number(stage.getAttribute('data-points') || 0), defects: Number(stage.getAttribute('data-defects') || 0) }
      : null;
  })()`);
  const path = await machine.shot(name);
  console.log(`  ${drawn ? `${drawn.points} 个点 · ${drawn.defects} 处缺陷` : "没等到点数"}　→ ${path}`);
  return drawn;
};

try {
  console.log(`内部点云取景探针 · ${BASE}`);
  await machine.start();
  if (!(await machine.login())) throw new Error("登录失败（shi）");
  await machine.evaluate(`location.hash = '#/twin'`);
  await machine.waitFor(`Boolean(document.querySelector('.page--twin'))`, { timeoutMs: 12_000 });
  await sleep(800);
  await machine.evaluate(`(() => {
    const tab = [...document.querySelectorAll('.twin-view__tab')].find((node) => (node.textContent || '').includes('内部点云'));
    tab?.click();
    return Boolean(tab);
  })()`);
  console.log("  ── 四根一起看 ──");
  await shotWhenDrawn("内部点云-四根");

  await machine.evaluate(`(() => {
    const button = [...document.querySelectorAll('.ipc__toggle')].find((node) => (node.textContent || '').includes('只看 Z04'));
    button?.click();
    return Boolean(button);
  })()`);
  console.log("  ── 只看 Z04（取景应收到这一根上，柱身要占满画面高度） ──");
  await shotWhenDrawn("内部点云-只看Z04");

  /* 只看破损：木料整层收掉，剩下的就是缺陷点（用户口径里的"破损可视化"） */
  await machine.evaluate(`(() => {
    const button = [...document.querySelectorAll('.ipc__toggle')].find((node) => (node.textContent || '').includes('只看破损'));
    button?.click();
    return Boolean(button);
  })()`);
  console.log("  ── 只看破损 ──");
  await shotWhenDrawn("内部点云-只看破损");
} catch (error) {
  console.error(`探针异常：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  machine.kill();
}
