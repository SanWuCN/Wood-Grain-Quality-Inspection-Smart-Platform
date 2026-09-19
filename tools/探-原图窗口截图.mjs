/**
 * 探：打开 ⑫ 的原图窗口并截图（人眼确认并排对照的观感）—— 只打印，不改数据
 *
 * 用法：node --import ./tools/test-resolve-ts.mjs tools/探-原图窗口截图.mjs [--url ...]
 */
import { Machine, sleep } from "./browser-harness.mjs";

const args = process.argv.slice(2);
const i = args.indexOf("--url");
const BASE = (i >= 0 && args[i + 1] ? args[i + 1] : "http://127.0.0.1:8000").replace(/\/$/, "");

const machine = new Machine({ name: "shot-opw", port: 9579, base: BASE, account: "shi" });
try {
  await machine.start();
  if (!(await machine.login())) throw new Error("登录失败");
  await machine.evaluate(`location.hash = '#/twin?component=Z04'`);
  await machine.waitFor(`Boolean(document.querySelector('.page--twin'))`, { timeoutMs: 12_000 });
  await sleep(1200);
  /* 直接派发 ⑫ 的事件（与那一轮播完时同一路径），省得等思考与播报 */
  await machine.evaluate(`window.dispatchEvent(new CustomEvent('mumai:original-photo', { detail: { componentId: 'Z04' } })); 1`);
  const opened = await machine.waitFor(`Boolean(document.querySelector('.opw'))`, { timeoutMs: 10_000 });
  await sleep(2500);
  const info = await machine.evaluate(`(() => {
    const win = document.querySelector('.opw');
    const panes = [...win.querySelectorAll('.opw__pane')];
    return {
      panes: panes.length,
      captions: panes.map((node) => (node.querySelector('figcaption')?.textContent || '').trim()),
      natural: [...win.querySelectorAll('.opw__img')].map((node) => node.naturalWidth),
    };
  })()`);
  console.log(`窗口已开：${opened} · 画面块 ${info.panes} · 原图解码宽度 ${info.natural.join(" / ")}`);
  for (const caption of info.captions) console.log(`  · ${caption}`);
  const shot = await machine.shot("⑫原图窗口-并排对照");
  console.log(`截图：${shot}`);
} catch (error) {
  console.error(`探针异常：${error?.message ?? error}`);
  process.exitCode = 1;
} finally {
  machine.kill();
}
