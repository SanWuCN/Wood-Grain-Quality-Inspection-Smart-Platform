/**
 * 探针：证据对照表**到底渲染出来没有**（行数 / 文本 / 高度）
 * 用法：node --import ./tools/test-resolve-ts.mjs tools/探-证据对照表.mjs
 */
import { Machine, sleep } from "./browser-harness.mjs";

const BASE = (process.argv.includes("--url") ? process.argv[process.argv.indexOf("--url") + 1] : "http://127.0.0.1:8000").replace(/\/$/, "");
const machine = new Machine({ name: "evd", port: 9605, base: BASE, account: "shi" });

try {
  await machine.start();
  if (!(await machine.login())) throw new Error("登录失败");
  await machine.evaluate(`location.hash = '#/twin'`);
  await machine.waitFor(`Boolean(document.querySelector('.page--twin'))`, { timeoutMs: 12_000 });
  await sleep(1500);
  await machine.evaluate(`window.dispatchEvent(new CustomEvent('mumai:twin-evidence', { detail: { componentId: 'Z04' } })); 1`);
  await sleep(1500);
  const info = await machine.evaluate(`(() => {
    const view = document.querySelector('.evd');
    if (!view) return { view: false };
    const rows = [...view.querySelectorAll('.evd__table tbody tr')];
    const panels = [...view.querySelectorAll('.panel, section')].map((node) => {
      const r = node.getBoundingClientRect();
      return {
        title: (node.querySelector('h1,h2,h3,h4,.panel__title,header')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 28),
        w: Math.round(r.width), h: Math.round(r.height),
      };
    });
    return {
      view: true,
      viewBox: (() => { const r = view.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
      rowCount: rows.length,
      rows: rows.map((row) => {
        const r = row.getBoundingClientRect();
        return { h: Math.round(r.height), text: (row.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) };
      }),
      supplement: view.querySelectorAll('.evd__supplement li').length,
      panels,
    };
  })()`);
  console.log(JSON.stringify(info, null, 1));
} catch (error) {
  console.error(`探针异常：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  machine.kill();
}
