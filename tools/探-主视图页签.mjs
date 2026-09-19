/**
 * 探针：主视图页签（外观 · 高斯场景 / 内部点云）在页面上**到底长在哪儿**、看不看得见
 *
 * 用户 2026-10-01 问「3D 点云图去哪儿查看」——要么入口太小，要么被画布盖住了。
 * 这条探针把关键元素的矩形、层级与可见性打出来，别靠猜。
 *
 * 用法：node --import ./tools/test-resolve-ts.mjs tools/探-主视图页签.mjs
 */
import { Machine, sleep } from "./browser-harness.mjs";

const BASE = (process.argv.includes("--url") ? process.argv[process.argv.indexOf("--url") + 1] : "http://127.0.0.1:8000").replace(/\/$/, "");
const machine = new Machine({ name: "twin-tabs", port: 9581, base: BASE, account: "shi" });

try {
  await machine.start();
  if (!(await machine.login())) throw new Error("登录失败（shi）");
  await machine.evaluate(`location.hash = '#/twin'`);
  await machine.waitFor(`Boolean(document.querySelector('.page--twin'))`, { timeoutMs: 12_000 });
  await sleep(1200);

  const info = await machine.evaluate(`(() => {
    const rect = (node) => {
      if (!node) return null;
      const r = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        display: style.display, visibility: style.visibility, opacity: style.opacity, zIndex: style.zIndex,
        overflow: style.overflow, color: style.color, background: style.backgroundColor,
      };
    };
    const views = document.querySelector('.twin-views');
    const tabs = [...document.querySelectorAll('.twin-view__tab')];
    /* 页签中心点上最顶层的是谁：被盖住的话这里会返回画布而不是按钮 */
    const first = tabs[0];
    const box = first?.getBoundingClientRect();
    const hit = box ? document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) : null;
    return {
      views: rect(views),
      viewsText: (views?.textContent || '').trim(),
      tabs: tabs.map((node) => ({ text: (node.textContent || '').trim(), ...rect(node) })),
      stage: rect(document.querySelector('.twin-stage')),
      view: rect(document.querySelector('.twin-view')),
      canvas: rect(document.querySelector('.twin-view canvas') || document.querySelector('.twin-stage canvas')),
      topAtFirstTab: hit ? hit.className || hit.tagName : null,
    };
  })()`);
  console.log(JSON.stringify(info, null, 2));
  const shot = await machine.shot("主视图页签");
  console.log(`截图：${shot}`);
} catch (error) {
  console.error(`探针异常：${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  machine.kill();
}
